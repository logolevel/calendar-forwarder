require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { pool, initDB } = require('./db');

initDB();

const bot = new Telegraf(process.env.BOT_TOKEN); 
const app = express();
app.use(express.json());

async function isAdmin(ctx) {
    if (ctx.chat.type === 'private') return false;
    try {
        const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        return ['administrator', 'creator'].includes(member.status);
    } catch (e) {
        return false;
    }
}

bot.command('stats', async (ctx) => {
    const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
    
    if (ctx.from.id !== ADMIN_ID) return;

    try {
        const res = await pool.query('SELECT calendar_id, chat_id, created_at FROM subscriptions');
        
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
            text += `${i + 1}. <b>${chatTitle}</b>\n`;
            text += `Календар: <code>${row.calendar_id}</code>\n`;
            text += `Chat ID: <code>${row.chat_id}</code>\n`;
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
    if (!(await isAdmin(ctx))) {
        return;
    }
    const args = ctx.message.text.split(' ');
    const calendarId = args[1];
    
    if (!calendarId) {
        const msg = await ctx.reply('⚠️ Формат команди: /bind <calendar_id>\nНаприклад: /bind test@group.calendar.google.com');
        setTimeout(() => {
            ctx.deleteMessage(msg.message_id).catch(() => {});
            ctx.deleteMessage(ctx.message.message_id).catch(() => {});
        }, 10000);
        return;
    }
    
    try {
        const checkRes = await pool.query('SELECT chat_id FROM subscriptions WHERE calendar_id = $1', [calendarId]);
        
        if (checkRes.rows.length > 0) {
            const existingChatId = checkRes.rows[0].chat_id;
            
            if (existingChatId === ctx.chat.id) {
                const replyMsg = await ctx.reply(`⚠️ Цей календар вже прив'язаний до поточної групи.`);
                setTimeout(() => {
                    ctx.deleteMessage(replyMsg.message_id).catch(() => {});
                    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
                }, 5000);
                return;
            }
            
            try {
                await ctx.telegram.getChat(existingChatId);
                const replyMsg = await ctx.reply(`⛔️ Помилка: Цей календар вже використовується в іншій активній групі. Спочатку відв'яжіть його там.`);
                setTimeout(() => {
                    ctx.deleteMessage(replyMsg.message_id).catch(() => {});
                    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
                }, 7000);
                return;
            } catch (e) {
            }
        }

        await pool.query(
            `INSERT INTO subscriptions (calendar_id, chat_id, added_by) 
             VALUES ($1, $2, $3) 
             ON CONFLICT (calendar_id) DO UPDATE SET chat_id = $2`,
            [calendarId, ctx.chat.id, ctx.from.id]
        );
        
        await ctx.reply(`✅ Календар успішно прив'язано до цієї групи!`);
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
        const msg = await ctx.reply('⚠️ Формат команди: /unbind <calendar_id>\nНаприклад: /unbind test@group.calendar.google.com');
        setTimeout(() => {
            ctx.deleteMessage(msg.message_id).catch(() => {});
            ctx.deleteMessage(ctx.message.message_id).catch(() => {});
        }, 10000);
        return;
    }

    try {
        const res = await pool.query('DELETE FROM subscriptions WHERE chat_id = $1 AND calendar_id = $2', [ctx.chat.id, calendarId]);
        if (res.rowCount > 0) {
            const replyMsg = await ctx.reply(`✅ Календар ${calendarId} відв'язано від цієї групи.`);
            setTimeout(() => {
                ctx.deleteMessage(replyMsg.message_id).catch(() => {});
            }, 5000);
        } else {
            const replyMsg = await ctx.reply(`⚠️ Календар ${calendarId} не був прив'язаний до цієї групи.`);
            setTimeout(() => {
                ctx.deleteMessage(replyMsg.message_id).catch(() => {});
            }, 5000);
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
        const replyMsg = await ctx.reply(`✅ Відв'язано календарів: ${res.rowCount}. Всі календарі відв'язано від цієї групи.`);
        setTimeout(() => {
            ctx.deleteMessage(replyMsg.message_id).catch(() => {});
        }, 5000);
        ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    } catch (error) {
        ctx.reply('❌ Помилка бази даних.');
    }
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

function buildMessage(eventDate, colorValue, currentTitle, creatorEmail, history, eventLink) {
    const emoji = getColorEmoji(colorValue);
    let text = `<blockquote>${emoji} ${eventDate}\n\n${currentTitle}\n\n`;
    const safeEmail = (creatorEmail || 'невідомо').replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');
    text += `<i>Створено: ${safeEmail}</i>\n\n`;
    if (eventLink) text += `<a href="${eventLink}">Посилання на подію</a>`;
    if (history && history.length > 0) {
        text += `\n\n🕒 Історія редагування:\n\n`;
        history.forEach((h, index) => {
            const timeStr = new Date(h.time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
            text += `${index + 1}. ${h.text} <i>(${timeStr})</i>\n`;
        });
    }
    text += `</blockquote>`;
    return text;
}

app.post('/calendar-webhook', async (req, res) => {
    const { calendarId, eventId, status, title, start, end, calendarTimeZone, colorId = '0', creatorEmail = 'невідомо', eventLink = '' } = req.body;
    if (!calendarId) return res.status(400).send('Missing calendarId');
    const client = await pool.connect();
    try {
        const subRes = await client.query('SELECT chat_id FROM subscriptions WHERE calendar_id = $1', [calendarId]);
        if (subRes.rows.length === 0) {
            client.release();
            return res.status(200).send('Calendar not bound');
        }
        const TARGET_CHAT_ID = subRes.rows[0].chat_id;
        const date = formatEventDate(start, end, calendarTimeZone);
        await client.query('BEGIN');
        const dbRes = await client.query('SELECT * FROM events WHERE google_event_id = $1 AND calendar_id = $2 FOR UPDATE', [eventId, calendarId]);
        const eventExists = dbRes.rows.length > 0;
        if (status === 'deleted') {
            if (eventExists) {
                 const event = dbRes.rows[0];
                 let finalHistory = event.history || [];
                 finalHistory.push({ time: new Date().toISOString(), text: `<s>${event.current_title}</s>` });
                 const safeEmail = (event.creator_email || 'невідомо').replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');
                 let updatedText = `<blockquote><b>Подія була видалена</b>\n\n<i>Створювалась: ${safeEmail}</i>\n\n🕒 Історія редагування:\n\n`;
                 finalHistory.forEach((h, index) => {
                     const timeStr = new Date(h.time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
                     updatedText += `${index + 1}. ${h.text} <i>(${timeStr})</i>\n`;
                 });
                 updatedText += `</blockquote>`;
                 try {
                     await bot.telegram.editMessageText(TARGET_CHAT_ID, event.message_id, null, updatedText, { parse_mode: 'HTML', disable_web_page_preview: true });
                 } catch (err) {}
                 await bot.telegram.sendMessage(TARGET_CHAT_ID, `Видалено`, { reply_parameters: { message_id: event.message_id } });
                 await client.query('DELETE FROM events WHERE id = $1', [event.id]);
            }
        } else if (!eventExists) {
            const text = buildMessage(date, colorId, title, creatorEmail, [], eventLink);
            const sentMessage = await bot.telegram.sendMessage(TARGET_CHAT_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
            await client.query(
                `INSERT INTO events (google_event_id, calendar_id, message_id, current_title, event_date, color_id, creator_email, event_link) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [eventId, calendarId, sentMessage.message_id, title, date, colorId, creatorEmail, eventLink]
            );
        } else {
            const event = dbRes.rows[0];
            let changes = [];
            if (event.current_title !== title) changes.push(`<s>${event.current_title}</s>`);
            if (event.event_date !== date) changes.push(`<s>${event.event_date}</s>`);
            if (event.color_id !== colorId) changes.push(`<s>Майданчик ${getColorEmoji(event.color_id)}</s>`);
            if (changes.length > 0) {
                 let newHistory = [...event.history, { time: new Date().toISOString(), text: changes.join(', ') }];
                 const finalLink = eventLink || event.event_link;
                 await client.query(
                     'UPDATE events SET current_title = $1, history = $2::jsonb, color_id = $3, event_date = $4, event_link = $5 WHERE id = $6',
                     [title, JSON.stringify(newHistory), colorId, date, finalLink, event.id]
                 );
                 const updatedText = buildMessage(date, colorId, title, event.creator_email, newHistory, finalLink);
                 try {
                     await bot.telegram.editMessageText(TARGET_CHAT_ID, event.message_id, null, updatedText, { parse_mode: 'HTML', disable_web_page_preview: true });
                 } catch (err) {}
                 await bot.telegram.sendMessage(TARGET_CHAT_ID, `Відредаговано`, { reply_parameters: { message_id: event.message_id } });
            }
        }
        await client.query('COMMIT');
        res.status(200).send('OK');
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).send('Error');
    } finally {
        client.release();
    }
});

bot.launch();
const PORT = process.env.PORT || 3000;
app.listen(PORT);
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));