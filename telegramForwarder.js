const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// ID роли и канала для оповещений о войнах — можно переопределить через .env,
// если не заданы — используются значения по умолчанию ниже.
const WAR_ROLE_ID = process.env.TG_WAR_ROLE_ID || '1515042126948335722';
const WAR_CHANNEL_ID = process.env.TG_WAR_CHANNEL_ID || '1515042128164552922';

// Опознаватели: по каким фразам в тексте понимаем, что сообщение нужно переслать.
// Оба типа теперь идут с упоминанием роли.
const IDENTIFIERS = [
  {
    // "Ваша организация забила ... войну" — войну объявили вы
    match: (line) => line.includes('Ваша организация забила'),
    build: (line) => `${line}\n<@&${WAR_ROLE_ID}>`,
  },
  {
    // "... забили Вашей организации войну" — войну объявили вам
    match: (line) => line.includes('забили Вашей организации'),
    build: (line) => `${line}\n<@&${WAR_ROLE_ID}>`,
  },
];

// Из всего текста сообщения достаём именно нужную строку (без шапки
// "📋 Организация: события | ..." и пустых строк).
function findMatchingLine(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const identifier = IDENTIFIERS.find((id) => id.match(line));
    if (identifier) return { line, identifier };
  }
  return null;
}

async function startTelegramForwarder(discordClient) {
  const apiId = parseInt(process.env.API_ID, 10);
  const apiHash = process.env.API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION;

  if (!apiId || !apiHash || !sessionString) {
    console.log('Пересылка Telegram → Discord выключена: не заданы API_ID / API_HASH / TELEGRAM_SESSION.');
    return;
  }

  const tgClient = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  await tgClient.connect();
  console.log('✅ Пересылка Telegram → Discord подключена (только сообщения о войнах организации).');

  tgClient.addEventHandler(async (event) => {
    try {
      if (!event.isPrivate) return; // только личные сообщения
      const message = event.message;
      if (!message || message.out) return; // не пересылаем свои же исходящие
      if (!message.message) return; // без текста — нечего искать

      const found = findMatchingLine(message.message);
      if (!found) return; // не подошло ни под один опознаватель — игнорируем

      const content = found.identifier.build(found.line).slice(0, 2000);

      const channel = await discordClient.channels.fetch(WAR_CHANNEL_ID).catch(() => null);
      if (!channel) {
        console.error('Не найден канал Discord для пересылки:', WAR_CHANNEL_ID);
        return;
      }

      await channel.send({ content });
      console.log('Переслано сообщение о войне:', found.line);
    } catch (e) {
      console.error('Ошибка обработки входящего Telegram-сообщения:', e);
    }
  }, new NewMessage({ incoming: true }));
}

module.exports = { startTelegramForwarder };
