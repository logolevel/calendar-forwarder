require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const { pool, initDB } = require('./db');
const path = require('path');

initDB();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/documentation', (req, res) => {
    res.sendFile(path.join(__dirname, 'documentation.html'));
});

cron.schedule('0 3 * * *', async () => {
    try {
        await pool.query(`DELETE FROM events WHERE event_end_time < NOW() - INTERVAL '7 days'`);
    } catch (error) {}
});

async function isAdmin(ctx) {
    if (ctx.chat.type === 'private') return false;
    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        return ['administrator', 'creator'].includes(member.status);
    } catch (e) {
        return false;
    }
}

async function getCalendarForChat(chatId) {
    const res = await pool.query('SELECT calendar_id FROM subscriptions WHERE chat_id = $1', [chatId]);
    return res.rows.length > 0 ? res.rows[0].calendar_id : null;
}

bot.command('stats', async (ctx) => {
    const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
    if (ctx.from.id !== ADMIN_ID) return;

    try {
        const res = await pool.query('SELECT calendar_id, chat_id, thread_id, days_limit, created_at FROM subscriptions');
        if (res.rows.length === 0) {
            return ctx.reply('📊 Бот поки не прив\'язаний до жодної групи.');
        }

        let text = `📊 <b>Статистика використання:</b>\nАктивних груп: ${res.rows.length}\n\n`;

        for (let i = 0; i < res.rows.length; i++) {
            const row = res.rows[i];
            let chatTitle = 'Невідома назва';
            try {
                const chat = await ctx.telegram.getChat(row.chat_id);
                chatTitle = chat.title || 'Приватний чат';
            } catch (e) {
                chatTitle = 'Група недоступна (бота видалено?)';
            }
            const date = new Date(row.created_at).toLocaleDateString('uk-UA');
            const threadInfo = row.thread_id ? ` (в темі)` : '';
            const limitInfo = row.days_limit > 0 ? ` (Ліміт: ${row.days_limit} дн.)` : ` (Без ліміту)`;

            const wlRes = await pool.query('SELECT email FROM whitelist WHERE calendar_id = $1', [row.calendar_id]);
            let whitelistInfo = 'порожній';
            if (wlRes.rows.length > 0) {
                whitelistInfo = wlRes.rows.map(w => w.email).join(', ');
            }

            text += `${i + 1}. <b>${chatTitle}</b>\n`;
            text += `Календар: <code>${row.calendar_id}</code>\n`;
            text += `Chat ID: <code>${row.chat_id}</code>${threadInfo}${limitInfo}\n`;
            text += `Білий список: <i>${whitelistInfo}</i>\n`;
            text += `Додано: ${date}\n\n`;
        }
        ctx.reply(text, { parse_mode: 'HTML' });
    } catch (error) {
        ctx.reply('❌ Помилка при отриманні статистики.');
    }
});

bot.command('bind', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('❌ Цю команду потрібно використовувати безпосередньо в групі.');
    }
    if (!(await isAdmin(ctx))) return;

    const args = ctx.message.text.split(' ');
    const calendarId = args[1];

    const threadId = ctx.message.message_thread_id || null;

    if (!calendarId) {
        await ctx.reply('⚠️ Формат команди: /bind <calendar_id>\nНаприклад: /bind test@group.calendar.google.com');
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
        return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(calendarId)) {
        await ctx.reply('⚠️ Некоректний формат ID календаря. Він має виглядати як email (наприклад: ...@group.calendar.google.com)');
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
        return;
    }

    try {
        const checkRes = await pool.query('SELECT chat_id, thread_id FROM subscriptions WHERE calendar_id = $1', [calendarId]);
        if (checkRes.rows.length > 0) {
            const existingChatId = checkRes.rows[0].chat_id;
            const existingThreadId = checkRes.rows[0].thread_id;

            const strExistingThread = existingThreadId ? String(existingThreadId) : null;
            const strCurrentThread = threadId ? String(threadId) : null;
            const strExistingChat = String(existingChatId);
            const strCurrentChat = String(ctx.chat.id);

            if (strExistingChat === strCurrentChat) {
                if (strExistingThread === strCurrentThread) {
                    await ctx.reply(`⚠️ Цей календар вже прив'язаний до поточної групи/теми.`);
                    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
                    return;
                }
            } else {
                try {
                    await ctx.telegram.getChat(existingChatId);
                    await ctx.reply(`⛔️ Помилка: Цей календар вже використовується в іншій активній групі. Спочатку відв'яжіть його там.`);
                    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
                    return;
                } catch (e) {}
            }
        }

        await pool.query(
            `INSERT INTO subscriptions (calendar_id, chat_id, thread_id, added_by) VALUES ($1, $2, $3, $4) 
             ON CONFLICT (calendar_id) DO UPDATE SET chat_id = $2, thread_id = $3`,
            [calendarId, ctx.chat.id, threadId, ctx.from.id]
        );

        await ctx.reply(`✅ Календар успішно прив'язано! Тепер сповіщення будуть приходити сюди.`);
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    } catch (error) {
        ctx.reply('❌ Помилка бази даних при збереженні.');
    }
});

bot.command('unbind', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('❌ Цю команду потрібно використовувати безпосередньо в групі.');
    }
    if (!(await isAdmin(ctx))) return;

    const args = ctx.message.text.split(' ');
    const calendarId = args[1];

    if (!calendarId) {
        await ctx.reply('⚠️ Формат команди: /unbind <calendar_id>\nНаприклад: /unbind test@group.calendar.google.com');
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
        return;
    }

    try {
        const res = await pool.query('DELETE FROM subscriptions WHERE chat_id = $1 AND calendar_id = $2', [ctx.chat.id, calendarId]);
        if (res.rowCount > 0) {
            await ctx.reply(`✅ Календар відв'язано від цієї групи.`);
        } else {
            await ctx.reply(`⚠️ Цей календар не був прив'язаний до цієї групи.`);
        }
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    } catch (error) {
        ctx.reply('❌ Помилка бази даних.');
    }
});

bot.command('unbindall', async (ctx) => {
    if (ctx.chat.type === 'private') {
        return ctx.reply('❌ Цю команду потрібно використовувати безпосередньо в групі.');
    }
    if (!(await isAdmin(ctx))) return;

    try {
        const res = await pool.query('DELETE FROM subscriptions WHERE chat_id = $1', [ctx.chat.id]);
        await ctx.reply(`✅ Відв'язано календарів: ${res.rowCount}. Всі календарі відв'язано від цієї групи.`);
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    } catch (error) {
        ctx.reply('❌ Помилка бази даних.');
    }
});

bot.command('set_limit', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('❌ Тільки для груп.');
    if (!(await isAdmin(ctx))) return;

    ctx.deleteMessage(ctx.message.message_id).catch(() => {});

    const calendarId = await getCalendarForChat(ctx.chat.id);
    if (!calendarId) return ctx.reply('⚠️ У цій групі немає прив\'язаного календаря.');

    const args = ctx.message.text.split(' ');
    const limit = parseInt(args[1], 10);

    if (isNaN(limit) || limit < 0) {
        return ctx.reply('⚠️ Формат команди: /set_limit <кількість_днів>\nНаприклад: /set_limit 7\nЩоб зняти ліміт, введіть: /set_limit 0');
    }

    await pool.query('UPDATE subscriptions SET days_limit = $1 WHERE calendar_id = $2', [limit, calendarId]);
    const msg = limit === 0 
        ? '✅ Обмеження на створення подій знято.' 
        : `✅ Встановлено ліміт: не можна створювати події більше ніж на ${limit} днів вперед.`;
    ctx.reply(msg);
});

bot.command('add_whitelist', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('❌ Тільки для груп.');
    if (!(await isAdmin(ctx))) return;

    ctx.deleteMessage(ctx.message.message_id).catch(() => {});

    const calendarId = await getCalendarForChat(ctx.chat.id);
    if (!calendarId) return ctx.reply('⚠️ У цій групі немає прив\'язаного календаря.');

    const args = ctx.message.text.split(/\s+/);
    const rawEmail = args[1];
    if (!rawEmail || !rawEmail.includes('@')) return ctx.reply('⚠️ Формат команди: /add_whitelist <email>');

    const email = rawEmail.trim().toLowerCase();

    await pool.query('INSERT INTO whitelist (calendar_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [calendarId, email]);

    const safeEmail = email.replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');
    ctx.reply(`➕ Користувач ${safeEmail} тепер у білому списку і може офіційно ігнорувати закони часу. 😎✨`);
});

bot.command('remove_whitelist', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('❌ Тільки для груп.');
    if (!(await isAdmin(ctx))) return;

    ctx.deleteMessage(ctx.message.message_id).catch(() => {});

    const calendarId = await getCalendarForChat(ctx.chat.id);
    if (!calendarId) return ctx.reply('⚠️ У цій групі немає прив\'язаного календаря.');

    const args = ctx.message.text.split(/\s+/);
    const rawEmail = args[1];
    if (!rawEmail) return ctx.reply('⚠️ Формат команди: /remove_whitelist <email>');

    const email = rawEmail.trim().toLowerCase();

    const res = await pool.query('DELETE FROM whitelist WHERE calendar_id = $1 AND email = $2', [calendarId, email]);

    const safeEmail = email.replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');

    if (res.rowCount > 0) {
        ctx.reply(`➖ Користувач ${safeEmail} залишає білий список і повертається до життя звичайних смертних з лімітами. 🕰️📉`);
    } else {
        ctx.reply(`🤷‍♂️ Користувача ${safeEmail} і так немає в білому списку. Немає кого виганяти!`);
    }
});

bot.command('clear_whitelist', async (ctx) => {
    if (ctx.chat.type === 'private') return ctx.reply('❌ Тільки для груп.');
    if (!(await isAdmin(ctx))) return;

    ctx.deleteMessage(ctx.message.message_id).catch(() => {});

    const calendarId = await getCalendarForChat(ctx.chat.id);
    if (!calendarId) return ctx.reply('⚠️ У цій групі немає прив\'язаного календаря.');

    await pool.query('DELETE FROM whitelist WHERE calendar_id = $1', [calendarId]);
    ctx.reply('✅ Білий список повністю очищено.');
});

function formatEventDate(start, end, timeZone) {
    if (!start) return 'Дата не вказана';
    const months = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
    const tz = timeZone || 'Europe/Kyiv';
    if (start.date) {
        const parts = start.date.split('-');
        return `${parseInt(parts[2], 10)} ${months[parseInt(parts[1], 10) - 1]}, весь день`;
    } else if (start.dateTime && end && end.dateTime) {
        const startD = new Date(start.dateTime);
        const endD = new Date(end.dateTime);
        const options = { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' };
        const startStr = startD.toLocaleTimeString('uk-UA', options);
        const endStr = endD.toLocaleTimeString('uk-UA', options);
        const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric', month: 'numeric' }).formatToParts(startD);
        const day = dateParts.find(p => p.type === 'day').value;
        const monthIdx = parseInt(dateParts.find(p => p.type === 'month').value, 10) - 1;
        return `${day} ${months[monthIdx]}, з ${startStr} по ${endStr}`;
    }
    return 'Дата не вказана';
}

function parseEndTime(end) {
    if (!end) return null;
    if (end.dateTime) return end.dateTime;
    if (end.date) return `${end.date}T23:59:59Z`;
    return null;
}

function getColorEmoji(colorValue) {
    const colorMap = {
        '1': '🔵', '2': '🟢', '3': '🟣', '4': '🔴', '5': '🟡', '6': '🟠', '7': '🔵', '8': '🔘', '9': '🔵', '10': '🟢', '11': '🔴',
        '#AC725E': '🟤', '#D06B64': '🔴', '#F83A22': '🔴', '#FA573C': '🟠', '#FF7537': '🟠', '#FFAD46': '🟡', '#42D692': '🟢', 
        '#16A765': '🟢', '#7BD148': '🟢', '#B3DC6C': '🟢', '#FBE983': '🟡', '#FAD165': '🟡', '#92E1C0': '🟢', '#9FE1E7': '🔵', 
        '#9FC6E7': '🔵', '#4986E7': '🔵', '#9A9CFF': '🟣', '#B99AFF': '🟣', '#C2C2C2': '🔘', '#CABDBF': '🟤', '#CCA6AC': '🟣', 
        '#F691B2': '🌸', '#CD74E6': '🟣', '#A47AE2': '🟣', '#039BE5': '🔵'
    };
    const val = colorValue ? colorValue.toUpperCase() : '';
    return colorMap[val] || '⚪️';
}

function buildMessage(eventDate, colorValue, currentTitle, creatorEmail, history, eventLink, daysLimit = 0) {
    const emoji = getColorEmoji(colorValue);
    let text = `<blockquote>${emoji} ${eventDate}\n\n${currentTitle}\n\n`;
    const safeEmail = creatorEmail.replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');
    text += `<i>Створено: ${safeEmail}</i>\n\n`;
    if (eventLink) text += `<a href="${eventLink}">Посилання на подію</a>`;
    
    let hasFlagged = false;

    if (history && history.length > 0) {
        text += `\n\n🕒 Історія редагування:\n\n`;
        history.forEach((h, index) => {
            if (h.text.includes('❗️<b>')) hasFlagged = true;
            const timeStr = new Date(h.time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
            text += `${index + 1}. ${h.text} <i>(${timeStr})</i>\n`;
        });
        
        if (hasFlagged) {
            text += `\n❗️<b>Ця подія була відредагована поза межами ${daysLimit} денного ліміту</b>❗️\n`;
        }
    }
    text += `</blockquote>`;
    return text;
}

app.post('/calendar-webhook', async (req, res) => {
    const { calendarId, eventId, status, title, start, end, calendarTimeZone, colorId = '0' } = req.body;
    const rawCreatorEmail = req.body.creatorEmail || 'невідомо';
    const creatorEmail = rawCreatorEmail.trim().toLowerCase();
    const eventLink = req.body.eventLink || '';

    if (!calendarId) return res.status(400).json({ error: 'Missing calendarId' });
    const client = await pool.connect();
    try {
        const subRes = await client.query('SELECT chat_id, thread_id, days_limit FROM subscriptions WHERE calendar_id = $1', [calendarId]);
        if (subRes.rows.length === 0) {
            client.release();
            return res.status(200).json({ status: 'ignored' });
        }
        const TARGET_CHAT_ID = subRes.rows[0].chat_id;
        const TARGET_THREAD_ID = subRes.rows[0].thread_id;
        const daysLimit = subRes.rows[0].days_limit || 0;

        await client.query('BEGIN');
        const dbRes = await client.query('SELECT * FROM events WHERE google_event_id = $1 AND calendar_id = $2 FOR UPDATE', [eventId, calendarId]);
        const eventExists = dbRes.rows.length > 0;

        let isOutsideLimit = false;
        if (daysLimit > 0) {
            let checkDate = null;
            if (start && (start.dateTime || start.date)) checkDate = new Date(start.dateTime || start.date);
            else if (eventExists && dbRes.rows[0].event_end_time) checkDate = new Date(dbRes.rows[0].event_end_time);
            if (checkDate) {
                const diffTimeMs = checkDate.getTime() - new Date().getTime();
                if (diffTimeMs > (daysLimit * 24 * 60 * 60 * 1000)) isOutsideLimit = true;
            }
        }

        let isFlaggedEdit = false;
        if (isOutsideLimit) {
            if (!eventExists && status !== 'deleted') {
                const wlRes = await client.query('SELECT 1 FROM whitelist WHERE calendar_id = $1 AND email = $2', [calendarId, creatorEmail]);
                if (wlRes.rows.length === 0) {
                    const diffTimeMs = new Date(start.dateTime || start.date).getTime() - new Date().getTime();
                    const diffDays = Math.floor(diffTimeMs / (1000 * 60 * 60 * 24));
                    const diffHours = Math.floor((diffTimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    const diffMinutes = Math.floor((diffTimeMs % (1000 * 60 * 60)) / (1000 * 60));
                    const safeEmail = creatorEmail.replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');
                    let warningText = `⏳ <b>Обережно, мандрівники у часі!</b>\n\nКористувач <i>${safeEmail}</i> спробував створити подію "${title}" на <b>${diffDays} дн. ${diffHours} год. і ${diffMinutes} хв.</b> вперед.\nНагадую про ліміт <b>${daysLimit} діб</b>. 📅\n\n<i>Я прибрав цю подію з календаря. 🧹✨</i>`;
                    let sendOptions = { parse_mode: 'HTML' };
                    if (TARGET_THREAD_ID) sendOptions.message_thread_id = TARGET_THREAD_ID;
                    await bot.telegram.sendMessage(TARGET_CHAT_ID, warningText, sendOptions);
                    await client.query('ROLLBACK');
                    client.release();
                    return res.status(200).json({ action: 'delete' });
                }
            } else if (eventExists) {
                isFlaggedEdit = true;
            }
        }

        const date = formatEventDate(start, end, calendarTimeZone);
        const endTime = parseEndTime(end);

        if (status === 'deleted') {
            if (eventExists) {
                const event = dbRes.rows[0];
                let history = event.history || [];
                let deleteText = `<s>${event.current_title}</s>`;

                if (isFlaggedEdit) deleteText = `❗️<b>${deleteText}</b>❗️`;
                
                history.push({ time: new Date().toISOString(), text: deleteText });
                
                const safeEmail = event.creator_email.replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');
                
                const emoji = getColorEmoji(event.color_id);
                let updatedText = `<blockquote><s>${emoji} ${event.event_date}</s>\n\n<b>Подія була видалена</b>\n\n<i>Створювалась: ${safeEmail}</i>\n\n🕒 Історія редагування:\n\n`;
                
                let hasFlagged = false;
                history.forEach((h, i) => {
                    if (h.text.includes('❗️<b>')) hasFlagged = true;
                    const timeStr = new Date(h.time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
                    updatedText += `${i + 1}. ${h.text} <i>(${timeStr})</i>\n`;
                });
                
                if (isFlaggedEdit) {
                    updatedText += `\n❗️<b>Ця подія була видалена поза межами ${daysLimit} денного ліміту</b>❗️\n`;
                } else if (hasFlagged) {
                    updatedText += `\n❗️<b>Ця подія була відредагована поза межами ${daysLimit} денного ліміту</b>❗️\n`;
                }
                
                updatedText += `</blockquote>`;
                try { await bot.telegram.editMessageText(TARGET_CHAT_ID, event.message_id, null, updatedText, { parse_mode: 'HTML', disable_web_page_preview: true }); } catch (e) {}
                
                await bot.telegram.sendMessage(TARGET_CHAT_ID, `❌ Видалено`, { reply_parameters: { message_id: event.message_id } });
                await client.query('DELETE FROM events WHERE id = $1', [event.id]);
            }
        } else if (!eventExists) {
            const text = buildMessage(date, colorId, title, creatorEmail, [], eventLink, daysLimit);
            let opt = { parse_mode: 'HTML', disable_web_page_preview: true };
            if (TARGET_THREAD_ID) opt.message_thread_id = TARGET_THREAD_ID;
            
            const sent = await bot.telegram.sendMessage(TARGET_CHAT_ID, text, opt);
            
            await client.query(
                `INSERT INTO events (google_event_id, calendar_id, message_id, current_title, event_date, color_id, creator_email, event_link, event_end_time) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, 
                [eventId, calendarId, sent.message_id, title, date, colorId, creatorEmail, eventLink, endTime]
            );
        } else {
            const event = dbRes.rows[0];
            let changes = [];
            if (event.current_title !== title) changes.push(`<s>${event.current_title}</s>`);
            if (event.event_date !== date) changes.push(`<s>${event.event_date}</s>`);
            if (event.color_id !== colorId) changes.push(`<s>Майданчик ${getColorEmoji(event.color_id)}</s>`);
            
            if (changes.length > 0 || isFlaggedEdit) {
                let rec = changes.length > 0 ? changes.join(', ') : 'Оновлення без текстових змін';
                
                if (isFlaggedEdit) rec = `❗️<b>${rec}</b>❗️`;
                
                let newH = [...event.history, { time: new Date().toISOString(), text: rec }];
                await client.query('UPDATE events SET current_title=$1, history=$2::jsonb, color_id=$3, event_date=$4, event_link=$5, event_end_time=$6 WHERE id=$7', [title, JSON.stringify(newH), colorId, date, (eventLink || event.event_link), endTime, event.id]);
                
                const updText = buildMessage(date, colorId, title, event.creator_email, newH, (eventLink || event.event_link), daysLimit);
                try { await bot.telegram.editMessageText(TARGET_CHAT_ID, event.message_id, null, updText, { parse_mode: 'HTML', disable_web_page_preview: true }); } catch (e) {}
                await bot.telegram.sendMessage(TARGET_CHAT_ID, `Відредаговано`, { reply_parameters: { message_id: event.message_id } });
            }
        }
        await client.query('COMMIT');
        res.status(200).json({ status: 'ok' });
    } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Server Error' }); } finally { client.release(); }
});

bot.launch();
const PORT = process.env.PORT || 3000;
app.listen(PORT);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));