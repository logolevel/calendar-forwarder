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
    const colorMap = {
        '1': '🔵', '2': '🟢', '3': '🟣', '4': '🔴', '5': '🟡', 
        '6': '🟠', '7': '🔵', '8': '🔘', '9': '🔵', '10': '🟢', '11': '🔴',
        '#AC725E': '🟤', '#D06B64': '🔴', '#F83A22': '🔴', '#FA573C': '🟠', '#FF7537': '🟠',
        '#FFAD46': '🟡', '#42D692': '🟢', '#16A765': '🟢', '#7BD148': '🟢', '#B3DC6C': '🟢',
        '#FBE983': '🟡', '#FAD165': '🟡', '#92E1C0': '🟢', '#9FE1E7': '🔵', '#9FC6E7': '🔵',
        '#4986E7': '🔵', '#9A9CFF': '🟣', '#B99AFF': '🟣', '#C2C2C2': '🔘', '#CABDBF': '🟤',
        '#CCA6AC': '🟣', '#F691B2': '🌸', '#CD74E6': '🟣', '#A47AE2': '🟣', '#039BE5': '🔵'
    };

    const val = colorValue ? colorValue.toUpperCase() : '';
    return colorMap[val] || '⚪️';
}

function buildMessage(eventDate, colorValue, currentTitle, creatorEmail, history, eventLink) {
    const emoji = getColorEmoji(colorValue);
    let text = `${emoji} ${eventDate}\n\n`;
    text += `${currentTitle}\n\n`;
    
    const safeEmail = creatorEmail.replace(/@/g, '@\u200B').replace(/\./g, '.\u200B');
    text += `<i>Створено: ${safeEmail}</i>\n\n`;
    
    if (eventLink) {
        text += `<a href="${eventLink}">Посилання на подію</a>`;
    }
    
    if (history && history.length > 0) {
        text += `\n\n🕒 Історія редагування:\n\n`;
        history.forEach((h, index) => {
            const timeStr = new Date(h.time).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
            text += `${index + 1}. ${h.text} <i>(${timeStr})</i>\n`;
        });
    }
    return text;
}

app.post('/calendar-webhook', async (req, res) => {
    const { eventId, status, title, date, colorId = '0', creatorEmail = 'невідомо', eventLink = '' } = req.body;

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
            const text = buildMessage(date, colorId, title, creatorEmail, [], eventLink);
            
            const sentMessage = await bot.telegram.sendMessage(CHAT_ID, text, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });

            await pool.query(
                `INSERT INTO events (google_event_id, message_id, current_title, event_date, color_id, creator_email, event_link) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [eventId, sentMessage.message_id, title, date, colorId, creatorEmail, eventLink]
            );

        } else {
            const event = dbRes.rows[0];
            let changes = [];
            
            if (event.current_title !== title) {
                changes.push(`<s>${event.current_title}</s>`);
            }
            if (event.event_date !== date) {
                changes.push(`<s>${event.event_date}</s>`);
            }
            if (event.color_id !== colorId) {
                changes.push(`<s>Майданчик ${getColorEmoji(event.color_id)}</s>`);
            }
            
            if (changes.length === 0) {
                return res.status(200).send('OK');
            }
            
            let newHistory = [...event.history, { time: new Date().toISOString(), text: changes.join(', ') }];
            const finalLink = eventLink || event.event_link;

            await pool.query(
                'UPDATE events SET current_title = $1, history = $2::jsonb, color_id = $3, event_date = $4, event_link = $5 WHERE google_event_id = $6',
                [title, JSON.stringify(newHistory), colorId, date, finalLink, eventId]
            );

            const updatedText = buildMessage(date, colorId, title, event.creator_email, newHistory, finalLink);
            
            try {
                await bot.telegram.editMessageText(CHAT_ID, event.message_id, null, updatedText, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
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