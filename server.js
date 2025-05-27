require('dotenv').config();
const express = require('express');
const axios = require('axios');
const basicAuth = require('express-basic-auth');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());

// Конфигурация
const SALEBOT_API_URL = 'https://api.salebot.pro/api/v1';
const clientCache = new NodeCache({ stdTTL: 600 });

// Middleware для базовой авторизации
app.use('/admin', basicAuth({
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASSWORD },
    challenge: true
}));

// Обработка вебхука Salebot
app.post('/salebot-webhook', async (req, res) => {
    try {
        const event = req.body;
        const clientId = event.client?.id;
        
        // Сохранение UTM-параметров
        if (clientId && req.query.utm_fb_pixel) {
            await updateSalebotClient(clientId, {
                utm_fb_pixel: req.query.utm_fb_pixel,
                utm_fb_token: req.query.utm_fb_token,
                utm_source: req.query.utm_source,
                utm_campaign: req.query.utm_campaign
            });
        }

        // Обработка событий
        if (event.type === 'subscribe') {
            await sendFacebookEvent(clientId, 'Subscribe');
        }

        if (['purchase', 'registration'].includes(event.type)) {
            await sendFacebookEvent(clientId, event.type);
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).send('Error');
    }
});

// Админ-панель
app.get('/admin', async (req, res) => {
    try {
        const clients = await getSalebotClients();
        res.send(generateAdminHtml(clients));
    } catch (error) {
        res.status(500).send('Error fetching clients');
    }
});

// Вспомогательные функции
async function getSalebotClient(clientId) {
    const cached = clientCache.get(clientId);
    if (cached) return cached;

    try {
        const response = await axios.post(`${SALEBOT_API_URL}/get_client`, {
            id: clientId,
            api_key: process.env.SALEBOT_API_KEY
        });
        clientCache.set(clientId, response.data.client);
        return response.data.client;
    } catch (error) {
        console.error('Salebot API error:', error.response?.data);
        return null;
    }
}

async function updateSalebotClient(clientId, data) {
    await axios.post(`${SALEBOT_API_URL}/update_client`, {
        api_key: process.env.SALEBOT_API_KEY,
        client_id: clientId,
        update_data: data
    });
    clientCache.del(clientId);
}

async function sendFacebookEvent(clientId, eventName) {
    const client = await getSalebotClient(clientId);
    if (!client || !client.utm_fb_pixel || !client.utm_fb_token) return;

    await axios.post(
        `https://graph.facebook.com/v12.0/${client.utm_fb_pixel}/events`,
        {
            data: [{
                event_name: eventName,
                event_time: Math.floor(Date.now()/1000),
                user_data: {
                    client_ip_address: client.ip,
                    client_user_agent: client.user_agent,
                    fbc: client.fbclid ? `fb.1.${Date.now()}.${client.fbclid}` : null
                }
            }],
            access_token: client.utm_fb_token
        }
    );
}

function generateAdminHtml(clients) {
    return `
    <html>
    <style>
        table {border-collapse: collapse; width: 100%;}
        td, th {border: 1px solid #ddd; padding: 8px;}
        tr:nth-child(even){background-color: #f2f2f2;}
    </style>
    <body>
        <h1>Clients (${clients.length})</h1>
        <table>
            <tr>
                <th>Client ID</th>
                <th>Name</th>
                <th>Status</th>
                <th>UTM Source</th>
                <th>FB Pixel</th>
                <th>Last Activity</th>
            </tr>
            ${clients.map(c => `
                <tr>
                    <td>${c.id}</td>
                    <td>${c.name || '-'}</td>
                    <td>${c.status}</td>
                    <td>${c.utm_source || '-'}</td>
                    <td>${c.utm_fb_pixel ? c.utm_fb_pixel.slice(0,6) + '...' : '-'}</td>
                    <td>${new Date(c.last_activity).toLocaleString()}</td>
                </tr>
            `).join('')}
        </table>
    </body>
    </html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));