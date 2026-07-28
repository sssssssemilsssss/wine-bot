const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// ID роли и канала для оповещений о войнах — можно переопределить через .env,
// если не заданы — используются значения по умолчанию ниже.
const WAR_ROLE_ID = process.env.TG_WAR_ROLE_ID || '1515042126948335722';
const WAR_CHANNEL_ID = process.env.TG_WAR_CHANNEL_ID || '1515042128164552922';

// Канал KD-VZP, где живёт статус "когда доступна следующая атака/защита".
const STATUS_CHANNEL_ID = process.env.TG_STATUS_CHANNEL_ID || '1531782412894343208';

// Картинка в статус-сообщении KD-VZP. Ссылка на картинку — как получить, см. README/инструкцию.
// Пусто = картинка не показывается.
const STATUS_IMAGE_URL = process.env.TG_STATUS_IMAGE_URL || 'https://i.imgur.com/rJmeaYM.png';

// Кулдауны после объявления войны.
const ATT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 часа
const DEFF_COOLDOWN_MS = 90 * 60 * 1000; // 1 час 30 минут

// Окно, когда играть ВЗП нельзя: с 01:00 до 12:59 по МСК.
const MSK_TZ = 'Europe/Moscow';
const BLACKOUT_START_HOUR = 1; // 01:00
const BLACKOUT_END_HOUR = 13; // до 13:00 (не включительно)

// Общий кусок в конце строки: "на 23:00, 20х20, алкоголь/анальгетики, косяки/SPANK разрешены."
const DETAILS_RE = /на (\d{1,2}:\d{2}),\s*([^,]+),\s*(.+?)\s*разрешены\.?\s*$/i;

// Опознаватели: по каким фразам в тексте понимаем, что сообщение нужно переслать,
// и как разобрать строку на составляющие (тип, соперник, локация, время, состав, разрешёнка).
const IDENTIFIERS = [
  {
    // "Ваша организация забила ... войну" — войну объявили вы (атака)
    type: 'att',
    match: (line) => line.includes('Ваша организация забила'),
    parse: (line) => {
      const head = line.match(/^Ваша организация забила (.+?) войну за (.+?) на /i);
      const details = line.match(DETAILS_RE);
      if (!head || !details) return null;
      return {
        type: 'att',
        opponent: head[1].trim(),
        location: head[2].trim(),
        time: details[1].trim(),
        size: details[2].trim(),
        items: details[3].trim(),
      };
    },
  },
  {
    // "... забили Вашей организации войну" — войну объявили вам (защита)
    type: 'deff',
    match: (line) => line.includes('забили Вашей организации'),
    parse: (line) => {
      const head = line.match(/^(.+?) забили Вашей организации войну за (.+?) на /i);
      const details = line.match(DETAILS_RE);
      if (!head || !details) return null;
      return {
        type: 'deff',
        opponent: head[1].trim(),
        location: head[2].trim(),
        time: details[1].trim(),
        size: details[2].trim(),
        items: details[3].trim(),
      };
    },
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

// Красиво собираем сообщение для Discord. Если распарсить детали не удалось —
// откатываемся на исходную строку, чтобы точно ничего не потерять.
function buildForwardMessage(line, identifier) {
  const parsed = identifier.parse(line);

  if (!parsed) {
    return `# ⚔️ Война объявлена\n${line}\n<@&${WAR_ROLE_ID}>`;
  }

  const isAttack = parsed.type === 'att';
  const header = isAttack ? '# ⚔️ ВЗП — АТАКА' : '# 🛡️ ВЗП — ЗАЩИТА';
  const opponentLabel = isAttack ? '🏴 Организация' : '🚨 Организация';

  const lines = [
    header,
    `${opponentLabel}: **${parsed.opponent}**`,
    `📍 Точка: **${parsed.location}**`,
    `🕒 Время: **${parsed.time}**`,
    `👥 Количество: **${parsed.size}**`,
    `🧪 Резисты: ${parsed.items}`,
    '',
    `<@&${WAR_ROLE_ID}>`,
  ];

  return lines.join('\n');
}

// ---------- Время по МСК и окно недоступности ----------

function getMskHour(ts) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: MSK_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  return parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
}

function formatMskTime(ts) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: MSK_TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

function isBlackoutHour(hour) {
  return hour >= BLACKOUT_START_HOUR && hour < BLACKOUT_END_HOUR;
}

// Если время попадает в окно 01:00–12:59 МСК — переносим его на 13:00 МСК того же дня.
function pushPastBlackout(ts) {
  const hour = getMskHour(ts);
  if (!isBlackoutHour(hour)) return ts;

  const mskDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: MSK_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts)); // YYYY-MM-DD по МСК

  // 13:00 МСК = 10:00 UTC (МСК = UTC+3, без перехода на летнее время)
  return new Date(`${mskDateStr}T10:00:00.000Z`).getTime();
}

function formatRemaining(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0 || hours === 0) parts.push(`${minutes} мин`);
  return parts.join(' ');
}

// ---------- Статус-сообщение в канале KD-VZP ----------

const TIMERS_FILE = path.join(__dirname, 'warTimers.json');

function loadTimers() {
  try {
    return JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf8'));
  } catch {
    return { attAvailableAt: 0, deffAvailableAt: 0, statusMessageId: null };
  }
}

function saveTimers(data) {
  try {
    fs.writeFileSync(TIMERS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить warTimers.json:', e);
  }
}

let timers = loadTimers();
let lastRenderedKey = null;

// Текст статуса для одного типа (атака/защита): либо обратный отсчёт с точным
// московским временем, либо "недоступно" на время окна 01:00–12:59, либо "доступно".
function buildLineStatus(availableAt) {
  const now = Date.now();

  if (availableAt && availableAt > now) {
    return `⏳ Осталось ${formatRemaining(availableAt - now)} (в ${formatMskTime(availableAt)} МСК)`;
  }

  const hour = getMskHour(now);
  if (isBlackoutHour(hour)) {
    const resumeAt = pushPastBlackout(now);
    return `🚫 Недоступно — перерыв до ${formatMskTime(resumeAt)} МСК`;
  }

  return '✅ Доступно';
}

function buildStatusEmbed() {
  const embed = new EmbedBuilder()
    .setTitle('📊 Статус ВЗП')
    .setColor(0x5865f2)
    .addFields(
      { name: '⚔️ АТАКА', value: buildLineStatus(timers.attAvailableAt) },
      { name: '🛡️ ЗАЩИТА', value: buildLineStatus(timers.deffAvailableAt) }
    )
    .setFooter({ text: 'ВЗП недоступен с 01:00 до 13:00 МСК' })
    .setTimestamp();

  if (STATUS_IMAGE_URL) {
    embed.setImage(STATUS_IMAGE_URL);
  }

  return embed;
}

async function ensureStatusMessage(discordClient) {
  if (!STATUS_CHANNEL_ID) return null;

  const channel = await discordClient.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('Не найден канал KD-VZP для статуса:', STATUS_CHANNEL_ID);
    return null;
  }

  if (timers.statusMessageId) {
    const existing = await channel.messages.fetch(timers.statusMessageId).catch(() => null);
    if (existing) return existing;
  }

  const msg = await channel.send({ embeds: [buildStatusEmbed()] });
  timers.statusMessageId = msg.id;
  saveTimers(timers);
  lastRenderedKey = `${buildLineStatus(timers.attAvailableAt)}|${buildLineStatus(timers.deffAvailableAt)}`;
  return msg;
}

async function updateStatusMessage(discordClient) {
  if (!STATUS_CHANNEL_ID) return;
  try {
    const msg = await ensureStatusMessage(discordClient);
    if (!msg) return;

    const key = `${buildLineStatus(timers.attAvailableAt)}|${buildLineStatus(timers.deffAvailableAt)}`;
    if (key === lastRenderedKey) return; // ничего не поменялось — не дёргаем API зря

    lastRenderedKey = key;
    await msg.edit({ embeds: [buildStatusEmbed()] });
  } catch (e) {
    console.error('Не удалось обновить статус ВЗП:', e);
  }
}

// ---------- Основной запуск ----------

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

  if (STATUS_CHANNEL_ID) {
    await updateStatusMessage(discordClient);
    setInterval(() => updateStatusMessage(discordClient), 60 * 1000);
  }

  tgClient.addEventHandler(async (event) => {
    try {
      if (!event.isPrivate) return; // только личные сообщения
      const message = event.message;
      if (!message || message.out) return; // не пересылаем свои же исходящие
      if (!message.message) return; // без текста — нечего искать

      const found = findMatchingLine(message.message);
      if (!found) return; // не подошло ни под один опознаватель — игнорируем

      const content = buildForwardMessage(found.line, found.identifier).slice(0, 2000);

      const channel = await discordClient.channels.fetch(WAR_CHANNEL_ID).catch(() => null);
      if (!channel) {
        console.error('Не найден канал Discord для пересылки:', WAR_CHANNEL_ID);
        return;
      }

      await channel.send({ content });
      console.log('Переслано сообщение о войне:', found.line);

      // Запускаем/обновляем таймер соответствующего типа (с учётом окна 01:00–12:59 МСК)
      // и сразу обновляем статус в KD-VZP.
      const cooldownMs = found.identifier.type === 'att' ? ATT_COOLDOWN_MS : DEFF_COOLDOWN_MS;
      const availableAt = pushPastBlackout(Date.now() + cooldownMs);

      if (found.identifier.type === 'att') {
        timers.attAvailableAt = availableAt;
      } else {
        timers.deffAvailableAt = availableAt;
      }
      saveTimers(timers);

      await updateStatusMessage(discordClient);
    } catch (e) {
      console.error('Ошибка обработки входящего Telegram-сообщения:', e);
    }
  }, new NewMessage({ incoming: true }));
}

module.exports = { startTelegramForwarder };
