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

// Картинка в статус-сообщении KD-VZP.
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

// Опознаватели объявлений войны: по каким фразам понимаем, что войну объявили,
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

// Разбор строк-результатов боя. Регулярки без "^" в начале — на случай, если перед
// текстом стоит смайлик (шапку "📋 Организация: события | ..." при этом не трогаем,
// т.к. смотрим построчно и она сама не подходит ни под один паттерн).
function parseResultLine(line) {
  let m;

  m = line.match(/Удерживает\s+(.+?)\s+в\s+бою\s*#(\d+)/i);
  if (m) return { kind: 'win', warType: 'deff', location: m[1].trim(), battle: m[2] };

  m = line.match(/Захватывает\s+(.+?)\s+в\s+бою\s*#(\d+)/i);
  if (m) return { kind: 'win', warType: 'att', location: m[1].trim(), battle: m[2] };

  m = line.match(/Проигрывает\s+в\s+бою\s*#(\d+)\s+за\s+(.+?)\.?\s*$/i);
  if (m) return { kind: 'loss', warType: null, location: m[2].trim(), battle: m[1] };

  return null;
}

function findResultLine(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    const result = parseResultLine(line);
    if (result) return result;
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
const DEFAULT_TIMERS = {
  attAvailableAt: 0,
  deffAvailableAt: 0,
  statusMessageId: null,
  lastAttackAnnounce: null, // { opponent, location, announcedAt }
  lastDefenseAnnounce: null,
  lastAttackResult: null, // { time, opponent, location, battle, result: 'win'|'loss' }
  lastDefenseResult: null,
};

function loadTimers() {
  try {
    const data = JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf8'));
    return { ...DEFAULT_TIMERS, ...data };
  } catch {
    return { ...DEFAULT_TIMERS };
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
let statusRecreated = false; // пересоздаём старое сообщение статуса только один раз, при первом запуске после апдейта

// Текст статуса для одного типа (атака/защита): либо обратный отсчёт с точным
// московским временем, либо "недоступно" на время окна 01:00–12:59, либо "доступно".
function buildAvailabilityLine(availableAt) {
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

function buildResultLine(entry, label) {
  if (!entry) return `🕓 ${label}: нет данных`;
  const resultText = entry.result === 'win' ? '🏆 Победа' : '💀 Поражение';
  return `🕓 ${label}: ${formatMskTime(entry.time)} МСК, против **${entry.opponent}** — ${resultText} (бой #${entry.battle}, ${entry.location})`;
}

function buildStatusEmbed() {
  const attField = [buildAvailabilityLine(timers.attAvailableAt), buildResultLine(timers.lastAttackResult, 'Последняя атака')].join(
    '\n'
  );
  const deffField = [
    buildAvailabilityLine(timers.deffAvailableAt),
    buildResultLine(timers.lastDefenseResult, 'Последняя защита'),
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle('📊 Статус ВЗП')
    .setColor(0x5865f2)
    .addFields({ name: '⚔️ АТАКА', value: attField }, { name: '🛡️ ЗАЩИТА', value: deffField })
    .setFooter({ text: 'ВЗП недоступен с 01:00 до 13:00 МСК' })
    .setTimestamp();

  if (STATUS_IMAGE_URL) {
    embed.setImage(STATUS_IMAGE_URL);
  }

  return embed;
}

function renderKey() {
  return [
    buildAvailabilityLine(timers.attAvailableAt),
    buildAvailabilityLine(timers.deffAvailableAt),
    JSON.stringify(timers.lastAttackResult),
    JSON.stringify(timers.lastDefenseResult),
  ].join('|');
}

async function ensureStatusMessage(discordClient) {
  if (!STATUS_CHANNEL_ID) return null;

  const channel = await discordClient.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error('Не найден канал KD-VZP для статуса:', STATUS_CHANNEL_ID);
    return null;
  }

  // Один раз при старте бота удаляем старое сообщение статуса и создаём новое с нуля.
  if (!statusRecreated) {
    statusRecreated = true;
    if (timers.statusMessageId) {
      const old = await channel.messages.fetch(timers.statusMessageId).catch(() => null);
      if (old) await old.delete().catch(() => {});
      timers.statusMessageId = null;
    }
  }

  if (timers.statusMessageId) {
    const existing = await channel.messages.fetch(timers.statusMessageId).catch(() => null);
    if (existing) return existing;
  }

  const msg = await channel.send({ embeds: [buildStatusEmbed()] });
  timers.statusMessageId = msg.id;
  saveTimers(timers);
  lastRenderedKey = renderKey();
  return msg;
}

async function updateStatusMessage(discordClient) {
  if (!STATUS_CHANNEL_ID) return;
  try {
    const msg = await ensureStatusMessage(discordClient);
    if (!msg) return;

    const key = renderKey();
    if (key === lastRenderedKey) return; // ничего не поменялось — не дёргаем API зря

    lastRenderedKey = key;
    await msg.edit({ embeds: [buildStatusEmbed()] });
  } catch (e) {
    console.error('Не удалось обновить статус ВЗП:', e);
  }
}

// Обрабатываем результат боя (победа/поражение) и обновляем статус.
async function handleWarResult(result, discordClient) {
  let warType = result.warType;

  if (!warType) {
    // Поражение не говорит прямо, атака это была или защита — определяем по точке,
    // сверяясь с последним объявлением атаки/защиты на эту же локацию.
    if (timers.lastAttackAnnounce && timers.lastAttackAnnounce.location === result.location) {
      warType = 'att';
    } else if (timers.lastDefenseAnnounce && timers.lastDefenseAnnounce.location === result.location) {
      warType = 'deff';
    } else {
      const attAt = timers.lastAttackAnnounce ? timers.lastAttackAnnounce.announcedAt : 0;
      const deffAt = timers.lastDefenseAnnounce ? timers.lastDefenseAnnounce.announcedAt : 0;
      warType = attAt >= deffAt ? 'att' : 'deff';
    }
  }

  const announce = warType === 'att' ? timers.lastAttackAnnounce : timers.lastDefenseAnnounce;
  const entry = {
    time: Date.now(),
    opponent: announce ? announce.opponent : 'неизвестно',
    location: result.location,
    battle: result.battle,
    result: result.kind, // 'win' | 'loss'
  };

  if (warType === 'att') {
    timers.lastAttackResult = entry;
  } else {
    timers.lastDefenseResult = entry;
  }
  saveTimers(timers);

  await updateStatusMessage(discordClient);
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

      // 1) Объявление войны — пересылаем и запускаем таймер
      const found = findMatchingLine(message.message);
      if (found) {
        const parsed = found.identifier.parse(found.line);
        const content = buildForwardMessage(found.line, found.identifier).slice(0, 2000);

        const channel = await discordClient.channels.fetch(WAR_CHANNEL_ID).catch(() => null);
        if (!channel) {
          console.error('Не найден канал Discord для пересылки:', WAR_CHANNEL_ID);
        } else {
          await channel.send({ content });
          console.log('Переслано сообщение о войне:', found.line);
        }

        const cooldownMs = found.identifier.type === 'att' ? ATT_COOLDOWN_MS : DEFF_COOLDOWN_MS;
        const availableAt = pushPastBlackout(Date.now() + cooldownMs);

        if (found.identifier.type === 'att') {
          timers.attAvailableAt = availableAt;
          if (parsed) {
            timers.lastAttackAnnounce = { opponent: parsed.opponent, location: parsed.location, announcedAt: Date.now() };
          }
        } else {
          timers.deffAvailableAt = availableAt;
          if (parsed) {
            timers.lastDefenseAnnounce = { opponent: parsed.opponent, location: parsed.location, announcedAt: Date.now() };
          }
        }
        saveTimers(timers);
        await updateStatusMessage(discordClient);
        return;
      }

      // 2) Результат боя (победа/поражение) — только обновляем статус, не пересылаем отдельным сообщением
      const result = findResultLine(message.message);
      if (result) {
        await handleWarResult(result, discordClient);
      }
    } catch (e) {
      console.error('Ошибка обработки входящего Telegram-сообщения:', e);
    }
  }, new NewMessage({ incoming: true }));
}

module.exports = { startTelegramForwarder };
