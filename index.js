require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { pool, initDB } = require('./db');

initDB();

const bot = new Telegraf(process.env.BOT_TOKEN); 
const app = express();
app.use(express.json());

const CHAT_ID = process.env.CHAT_ID; 

function getColorEmoji(colorValue) {
    if (colorValue === '11' || colorValue === '4') return '🔴';
    if (colorValue === '10' || colorValue === '2') return '🟢';
    if (colorValue === '8') return '🔘';
    
    if (colorValue && colorValue.startsWith('#')) {
        const hex = colorValue.toUpperCase();
        if (['#D50000', '#E67C73', '#D81B60', '#F4511E'].includes(hex)) return '🔴';
        if (['#0B8043', '#33B679', '#009688', '#7CB342'].includes(hex)) return '🟢';
        if (['#616161', '#9E9E9E'].includes(hex)) return '🔘';
    }
    
    return '⚪️';
}

function buildMessage(eventDate, colorValue, currentTitle, creatorEmail, history) {
    const emoji = getColorEmoji(colorValue);
    let text = `${emoji} ${eventDate}\n\n`;
    text += `${currentTitle}\n\n`;
    text += `Створено: ${creatorEmail}`;
    
    if (history && history.length > 0) {
        text += `\n\n🕒 <b>Історія редагування:</b>\n\n`;
        history.forEach((h, index) => {
            text += `${index + 1}. <s>${h.text}</s>\n`;
        });
    }
    return text;
}

app.post('/calendar-webhook', async (req, res) => {
    const { eventId, status, title, date, colorId = '0', creatorEmail = 'невідомо' } = req.body;

    try {
        const dbRes = await pool.query('SELECT * FROM events WHERE google_event_id = $1', [eventId]);
        const eventExists = dbRes.rows.length > 0;

        if (status === 'deleted') {
            if (eventExists) {
                 await bot.telegram.sendMessage(CHAT_ID, `Видалено`, {
                    reply_parameters: { message_id: dbRes.rows[0].message_id }
                });
            }
        } else if (!eventExists) {
            const text = buildMessage(date, colorId, title, creatorEmail, []);
            
            const sentMessage = await bot.telegram.sendMessage(CHAT_ID, text, {
                parse_mode: 'HTML'
            });

            await pool.query(
                `INSERT INTO events (google_event_id, message_id, current_title, event_date, color_id, creator_email) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [eventId, sentMessage.message_id, title, date, colorId, creatorEmail]
            );

        } else {
            const event = dbRes.rows[0];
            let newHistory = event.history;
            
            if (event.current_title !== title) {
                 newHistory = [...event.history, { time: new Date().toISOString(), text: event.current_title }];
            }
            
            await pool.query(
                'UPDATE events SET current_title = $1, history = $2::jsonb, color_id = $3 WHERE google_event_id = $4',
                [title, JSON.stringify(newHistory), colorId, eventId]
            );

            const updatedText = buildMessage(event.event_date, colorId, title, event.creator_email, newHistory);
            
            try {
                await bot.telegram.editMessageText(CHAT_ID, event.message_id, null, updatedText, {
                    parse_mode: 'HTML'
                });
            } catch (err) {
                console.log(err);
            }

            await bot.telegram.sendMessage(CHAT_ID, `Відредаговано`, {
                reply_parameters: { message_id: event.message_id }
            });
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
});

bot.launch();

const PORT = process.env.PORT || 3000;
app.listen(PORT);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));