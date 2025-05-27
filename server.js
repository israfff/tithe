require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const basicAuth = require('express-basic-auth');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// Initialize Database
const db = new sqlite3.Database(process.env.DB_PATH);

// Create clients table
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,
    utm_source TEXT,
    fb_pixel TEXT,
    fb_token TEXT,
    last_activity DATETIME
  )`);
});

// Middleware для обработки UTM-параметров
app.use((req, res, next) => {
  const utmParams = {
    source: req.query.utm_source,
    pixel: req.query.utm_fb_pixel,
    token: req.query.utm_fb_token
  };

  if (utmParams.pixel && utmParams.token) {
    req.utmData = utmParams;
  }
  next();
});

// Проверка подписи вебхука
const verifyWebhook = (req, res, next) => {
  const signature = crypto
    .createHmac('sha256', process.env.SALEBOT_WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (signature !== req.headers['x-signature']) {
    return res.status(403).send('Invalid signature');
  }
  next();
};

// Админ-панель
app.use('/admin', basicAuth({
  users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASSWORD },
  challenge: true
}));

app.get('/admin', async (req, res) => {
  try {
    const clients = await getClientsFromDB();
    res.send(`
      <html>
      <style>
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; }
        tr:nth-child(even){ background-color: #f2f2f2; }
      </style>
      <body>
        <h1>Clients (${clients.length})</h1>
        <table>
          <tr>
            <th>ID</th>
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
              <td>${c.utm_source}</td>
              <td>${c.fb_pixel?.slice(0,6)}...</td>
              <td>${new Date(c.last_activity).toLocaleString()}</td>
            </tr>
          `).join('')}
        </table>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send('Error loading data');
  }
});

// Вебхук для Salebot
app.post('/salebot-webhook', verifyWebhook, async (req, res) => {
  try {
    const { event_type, client } = req.body;
    
    // Сохранение UTM-параметров
    if (req.utmData && client?.id) {
      await saveClientData(client.id, {
        fb_pixel: req.utmData.pixel,
        fb_token: req.utmData.token,
        utm_source: req.utmData.source
      });
    }

    // Обработка событий
    switch(event_type) {
      case 'subscribe':
        await sendFacebookEvent(client, 'Subscribe');
        break;
      
      case 'purchase':
        await sendFacebookEvent(client, 'Purchase', {
          value: client.order_value,
          currency: 'USD'
        });
        break;
      
      case 'registration':
        await sendFacebookEvent(client, 'CompleteRegistration');
        break;
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

// Функции работы с базой данных
async function saveClientData(clientId, data) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO clients 
      (id, utm_source, fb_pixel, fb_token, last_activity) 
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [clientId, data.utm_source, data.fb_pixel, data.fb_token],
      (err) => err ? reject(err) : resolve()
    );
  });
}

async function getClientsFromDB() {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM clients ORDER BY last_activity DESC', 
      (err, rows) => err ? reject(err) : resolve(rows));
  });
}

// Отправка событий в Facebook
async function sendFacebookEvent(client, eventName, customData = {}) {
  const userData = await getClientFromDB(client.id);
  
  try {
    await axios.post(
      `https://graph.facebook.com/v12.0/${userData.fb_pixel}/events`,
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        user_data: {
          client_ip_address: client.ip,
          client_user_agent: client.user_agent,
          fbc: client.fbclid ? `fb.1.${Date.now()}.${client.fbclid}` : null
        },
        custom_data: customData
      },
      {
        params: {
          access_token: userData.fb_token
        }
      }
    );
  } catch (error) {
    console.error('Facebook API Error:', error.response?.data);
  }
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  db.run('PRAGMA journal_mode = WAL'); // Оптимизация SQLite
});
