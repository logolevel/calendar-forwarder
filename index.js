require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { pool, initDB } = require('./db');

initDB();

const bot = new Telegraf(process.env.BOT_TOKEN); 
const app = express();
app.use(express.json());

const CHAT_ID = process.env.CHAT_ID; 

function getColorEmoji(colorId) {
    if (colorId === '11' || colorId === '4') return '🔴';
    if (colorId === '10' || colorId === '2') return '🟢';
    if (colorId === '8') return '🔘';
    return '⚪️';
}

function buildMessage(eventDate, colorId, shortType, isExpanded, currentTitle, history) {
    const emoji = getColorEmoji(colorId);
    let text = `<blockquote expandable>${emoji} <b>${shortType}</b>\n📅 Дата: ${eventDate}</blockquote>`;
    
    if (isExpanded) {
        text += `\n\n📝 <b>Поточний рядок:</b>\n<i>${currentTitle}</i>\n`;
        if (history && history.length > 0) {
            text += `\n🔄 <b>Історія змін:</b>\n`;
            history.forEach((h, index) => {
                text += `${index + 1}. ${h.text}\n`;
            });
        } else {
            text += `\n<i>Поки що без змін</i>`;
        }
    }
    return text;
}

app.post('/calendar-webhook', async (req, res) => {
    const { eventId, status, title, date, colorId = '0' } = req.body;
    const shortTypeMatch = title.match(/^([^\s,]+)/);
    const shortType = shortTypeMatch ? shortTypeMatch[1] : 'Тренування';

    try {
        if (status === 'created') {
            const text = buildMessage(date, colorId, shortType, false, title, []);
            const sentMessage = await bot.telegram.sendMessage(CHAT_ID, text, {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    Markup.button.callback('🔽 Деталі', `expand_${eventId}`)
                ])
            });

            await pool.query(
                `INSERT INTO events (google_event_id, message_id, current_title, event_date, color_id) 
                 VALUES ($1, $2, $3, $4, $5)`,
                [eventId, sentMessage.message_id, title, date, colorId]
            );

        } else if (status === 'updated') {
            const dbRes = await pool.query('SELECT * FROM events WHERE google_event_id = $1', [eventId]);
            if (dbRes.rows.length > 0) {
                const event = dbRes.rows[0];
                const newHistory = [...event.history, { time: new Date().toISOString(), text: event.current_title }];
                
                await pool.query(
                    'UPDATE events SET current_title = $1, history = $2::jsonb WHERE google_event_id = $3',
                    [title, JSON.stringify(newHistory), eventId]
                );

                const replyText = `✏️ <b>Подія була відредагована!</b>\nНовий рядок:\n<i>${title}</i>`;
                await bot.telegram.sendMessage(CHAT_ID, replyText, {
                    parse_mode: 'HTML',
                    reply_parameters: { message_id: event.message_id }
                });
            }
        } else if (status === 'deleted') {
            const dbRes = await pool.query('SELECT message_id FROM events WHERE google_event_id = $1', [eventId]);
            if (dbRes.rows.length > 0) {
                 await bot.telegram.sendMessage(CHAT_ID, `🗑 <b>Подія була видалена.</b>`, {
                    parse_mode: 'HTML',
                    reply_parameters: { message_id: dbRes.rows[0].message_id }
                });
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
});

bot.action(/^(expand|collapse)_(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    const eventId = ctx.match[2];

    try {
        const dbRes = await pool.query('SELECT * FROM events WHERE google_event_id = $1', [eventId]);
        
        if (dbRes.rows.length === 0) {
            return ctx.answerCbQuery('Дані не знайдені або застаріли.', { show_alert: true });
        }

        const event = dbRes.rows[0];
        const shortTypeMatch = event.current_title.match(/^([^\s,]+)/);
        const shortType = shortTypeMatch ? shortTypeMatch[1] : 'Тренування';
        const isExpanded = action === 'expand';

        const newText = buildMessage(event.event_date, event.color_id, shortType, isExpanded, event.current_title, event.history);
        const buttonText = isExpanded ? '🔼 Згорнути' : '🔽 Деталі';
        const nextAction = isExpanded ? `collapse_${eventId}` : `expand_${eventId}`;

        await ctx.editMessageText(newText, {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                Markup.button.callback(buttonText, nextAction)
            ])
        });

        await ctx.answerCbQuery();
    } catch (error) {
        console.error(error);
        await ctx.answerCbQuery('Відбулася помилка', { show_alert: true });
    }
});

bot.launch();

const PORT = process.env.PORT || 3000;
app.listen(PORT);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));