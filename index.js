require('dotenv').config();
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { loadLists, saveLists } = require('./storage');
const { loadVoiceData, saveVoiceData } = require('./voicestorage');
const { startTelegramForwarder } = require('./telegramForwarder');
const { loadBranches, saveBranches } = require('./branchesStorage');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// ---------- Ветки отчётов (!ветка) ----------
// Слово-команда, которой отвечают на сообщение со списком (тегами!), чтобы создать ветку отчётов.
const BRANCH_COMMAND = process.env.BRANCH_COMMAND || '!ветка';
// Как часто напоминать тем, кто ещё не залил отчёт (мс). По умолчанию раз в час.
const REPORT_REMINDER_MS = Number(process.env.REPORT_REMINDER_MS) || 60 * 60 * 1000;
// Кого тегнуть, когда все в ветке залили отчёты (можно несколько через запятую в .env).
const FINAL_PING_USER_IDS = (
  process.env.FINAL_PING_USER_IDS ||
  '686284779280531547,1474843848713703505,1123670020313055262'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Картинка в шапке набора людей (/wine). Просто ссылка на картинку — как её получить,
// см. инструкцию в README / ответе, где давалась эта правка. Пусто = картинка не показывается.
const RECRUIT_IMAGE_URL = process.env.RECRUIT_IMAGE_URL || 'https://i.imgur.com/FNzW39l.png';

// ---------- Эмодзи на кнопках ----------
// Единое место для всех эмодзи на кнопках бота. Сейчас тут обычные unicode-эмодзи —
// чтобы заменить на кастомные серверные, пришли мне список вида "название: <:имя:id>"
// (получить код можно, написав в чате \:имя_эмодзи: — Discord покажет сырой код),
// и я подставлю их сюда. Формат кастомного эмодзи для discord.js: '<:имя:id>' (или
// '<a:имя:id>' для анимированных) — просто строка, ничего больше менять не нужно.
const EMOJI = {
  join: '🟢',
  joinReserve: '⏳',
  leave: '🔴',
  manage: '🛠️',
  thread: '🧵',
  close: '🔒',
  open: '🔓',
  claimPosition: '🙋',
  leavePosition: '🚪',
  posManage: '🎖️',
  addAdmin: '🎖️',
  pingUnassigned: '📣',
  pingNotInVoice: '🔇',
  voiceRename: '✏️',
  voiceLimit: '👥',
  voicePrivacy: '🔒',
  voiceWaitingRoom: '⏳',
  voiceChat: '💬',
  voiceTrust: '✅',
  voiceUntrust: '🚫',
  voiceInvite: '📨',
  voiceKick: '🥾',
  voiceRegion: '🌍',
  voiceBlock: '⛔',
  voiceUnblock: '♻️',
  voiceClaim: '👑',
  voiceTransfer: '🔁',
  voiceDelete: '🗑️',
  confirmYes: '✅',
  confirmNo: '❌',
  addPerson: '🆕',
  removePerson: '🗑️',
  assignPosition: '🆕',
  removePosition: '🗑️',
};

if (!TOKEN || !CLIENT_ID) {
  console.error('Не заданы BOT_TOKEN и/или CLIENT_ID в переменных окружения (.env).');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Мелкие сбои (например, кратковременная ошибка Discord API) не должны валить весь процесс —
// без этого бот на хостинге мог падать целиком и перезапускаться заново.
process.on('unhandledRejection', (reason) => {
  console.error('Необработанный rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Необработанное исключение:', err);
});

const lists = loadLists();
const voiceData = loadVoiceData(); // { configs: { guildId: {triggerChannelId, categoryId} }, rooms: { channelId: {ownerId, guildId} } }
const branches = loadBranches(); // Map<threadId, branch> — ветки отчётов, см. handleBranchMessage()
const branchIntervals = new Map(); // threadId -> intervalHandle (в память, не сохраняется на диск)

function cid(...parts) {
  return parts.join(':');
}
function parseCid(customId) {
  return customId.split(':');
}

// ---------- Слэш-команда ----------
const wineCommand = new SlashCommandBuilder()
  .setName('wine')
  .setDescription('Создать набор участников')
  .addStringOption((opt) =>
    opt.setName('название').setDescription('Название события').setRequired(true).setMaxLength(100)
  )
  .addStringOption((opt) =>
    opt
      .setName('количество')
      .setDescription('Число участников или слово "Неограничено"')
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName('время').setDescription('Время набора').setRequired(true)
  )
  .addRoleOption((opt) =>
    opt
      .setName('роль')
      .setDescription('Роль, участников которой нужно оповестить')
      .setRequired(true)
  );

const voiceSetupCommand = new SlashCommandBuilder()
  .setName('voice-setup')
  .setDescription('Настроить систему кастомных голосовых комнат')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((opt) =>
    opt
      .setName('триггер')
      .setDescription('Голосовой канал-триггер: заходишь в него — создаётся своя комната')
      .addChannelTypes(ChannelType.GuildVoice)
      .setRequired(true)
  )
  .addChannelOption((opt) =>
    opt
      .setName('категория')
      .setDescription('Категория, куда будут создаваться комнаты')
      .addChannelTypes(ChannelType.GuildCategory)
      .setRequired(true)
  );

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = [wineCommand.toJSON(), voiceSetupCommand.toJSON()];
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log('Команды зарегистрированы для гильдии', GUILD_ID);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log('Команды зарегистрированы глобально (обновление может занять до часа)');
  }
}

// ---------- Вспомогательные функции ----------
function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function isFull(list) {
  if (list.quantity === 'Неограничено') return false;
  const n = parseInt(list.quantity, 10);
  if (Number.isNaN(n)) return false;
  return list.participants.length >= n;
}

function isManager(list, userId) {
  return list.creatorId === userId || list.admins.includes(userId);
}

async function notifyError(interaction, message) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral });
    }
  } catch (e) {
    console.error('Не удалось отправить сообщение об ошибке пользователю:', e);
  }
}

// Разбивает список строк на несколько эмбед-полей (лимит Discord — 1024 символа на значение).
function chunkFieldLines(lines) {
  let chunk = '';
  const chunks = [];
  for (const line of lines) {
    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > 1000) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function buildEmbed(list) {
  const qtyText =
    list.quantity === 'Неограничено'
      ? `${list.participants.length} 👥 / ♾️`
      : `${list.participants.length} 👥 / ${list.quantity}`;

  const statusText = !list.isOpen ? '🔴 Закрыт' : isFull(list) ? '🟡 Заполнен' : '🟢 Открыт';

  const fields = [
    { name: '📌 Статус', value: statusText, inline: true },
    { name: '📊 Количество', value: qtyText, inline: true },
    { name: '⏱️ Время', value: list.time, inline: true },
    { name: '👑 Организатор', value: `<@${list.creatorId}>`, inline: true },
    {
      name: '🎖️ Администраторы',
      value: list.admins.length ? list.admins.map((id) => `<@${id}>`).join(', ') : '_нет_',
      inline: true,
    },
  ];

  if (list.createdAt) {
    fields.push({ name: '🕐 Создан', value: `<t:${list.createdAt}:R>`, inline: true });
  }

  const participantLines = list.participants.length
    ? list.participants.map((id, i) => `\`${String(i + 1).padStart(2, '0')}\` <@${id}>`)
    : ['_пока никого — жми «Присоединиться» 🟢_'];

  chunkFieldLines(participantLines).forEach((val, i) => {
    fields.push({
      name: i === 0 ? `🟢 Участники (${list.participants.length})` : '\u200b',
      value: val,
    });
  });

  if (list.reserve && list.reserve.length) {
    const reserveLines = list.reserve.map((id, i) => `\`${String(i + 1).padStart(2, '0')}\` <@${id}>`);
    chunkFieldLines(reserveLines).forEach((val, i) => {
      fields.push({
        name: i === 0 ? `⏳ Резерв (${list.reserve.length})` : '\u200b',
        value: val,
      });
    });
  }

  const color = !list.isOpen ? 0x95a5a6 : isFull(list) ? 0xf1c40f : 0x5865f2;

  const embed = new EmbedBuilder()
    .setTitle(`🔥 ${list.title}`)
    .setColor(color)
    .addFields(fields)
    .setTimestamp();

  if (list.threadId) {
    embed.setDescription(`🧵 Ветка: <#${list.threadId}>`);
  }

  if (RECRUIT_IMAGE_URL) {
    embed.setImage(RECRUIT_IMAGE_URL);
  }

  embed.setFooter({
    text: !list.isOpen ? 'Сбор закрыт 🔒' : isFull(list) ? 'Основной состав заполнен ✅' : `ID набора: ${list.id}`,
  });

  return embed;
}

function buildMainRow(list) {
  const full = isFull(list);
  const joinBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'join', list.id))
    .setLabel(full ? 'В резерв' : 'Присоединиться')
    .setEmoji(full ? EMOJI.joinReserve : EMOJI.join)
    .setStyle(full ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(!list.isOpen);

  const leaveBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'leave', list.id))
    .setLabel('Покинуть')
    .setEmoji(EMOJI.leave)
    .setStyle(ButtonStyle.Danger);

  const manageBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'manage', list.id))
    .setLabel('Управление')
    .setEmoji(EMOJI.manage)
    .setStyle(ButtonStyle.Secondary);

  const threadBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'thread', list.id))
    .setLabel(list.threadId ? 'Ветка создана' : 'Создать ветку')
    .setEmoji(EMOJI.thread)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(list.threadId));

  const toggleBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'toggleopen', list.id))
    .setLabel(list.isOpen ? 'Закрыть сбор' : 'Открыть сбор')
    .setEmoji(list.isOpen ? EMOJI.close : EMOJI.open)
    .setStyle(list.isOpen ? ButtonStyle.Danger : ButtonStyle.Success);

  return new ActionRowBuilder().addComponents(joinBtn, leaveBtn, manageBtn, threadBtn, toggleBtn);
}

function buildPositionsEmbed(list) {
  const taken = list.positions.filter(Boolean).length;
  const lines = list.positions.map((uid, i) => {
    const num = String(i + 1).padStart(2, '0');
    return uid ? `\`${num}\` — <@${uid}>` : `\`${num}\` — _свободно_`;
  });

  return new EmbedBuilder()
    .setTitle('🏹 Список позиций')
    .setColor(0xf1c40f)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Занято: ${taken} / ${list.positionsCount}` })
    .setTimestamp();
}

function buildPositionsRow(list) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('wine', 'claimposition', list.id))
      .setLabel('Занять позицию')
      .setEmoji(EMOJI.claimPosition)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('wine', 'leaveposition', list.id))
      .setLabel('Покинуть позицию')
      .setEmoji(EMOJI.leavePosition)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid('wine', 'posmanage', list.id))
      .setLabel('Управление позициями')
      .setEmoji(EMOJI.posManage)
      .setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('wine', 'pingunassigned', list.id))
      .setLabel('Тегнуть незанявших')
      .setEmoji(EMOJI.pingUnassigned)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('wine', 'pingnotinvoice', list.id))
      .setLabel('Тегнуть незашедших в войс')
      .setEmoji(EMOJI.pingNotInVoice)
      .setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2];
}

async function updateListMessage(guild, list) {
  try {
    const channel = await guild.channels.fetch(list.channelId);
    const message = await channel.messages.fetch(list.messageId);
    await message.edit({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
  } catch (e) {
    console.error('Не удалось обновить сообщение набора:', e);
  }
}

async function updatePositionsMessage(guild, list) {
  if (!list.positionsCount || !list.threadId || !list.positionsMessageId) return;
  try {
    const thread = await guild.channels.fetch(list.threadId);
    const message = await thread.messages.fetch(list.positionsMessageId);
    await message.edit({ embeds: [buildPositionsEmbed(list)], components: buildPositionsRow(list) });
  } catch (e) {
    console.error('Не удалось обновить список позиций:', e);
  }
}

function freeUserPosition(list, userId) {
  if (!list.positions) return false;
  let changed = false;
  list.positions = list.positions.map((p) => {
    if (p === userId) {
      changed = true;
      return null;
    }
    return p;
  });
  return changed;
}

function chunkMentions(userIds, prefix) {
  const chunks = [];
  let current = prefix;
  for (const id of userIds) {
    const mention = `<@${id}> `;
    if ((current + mention).length > 1900) {
      chunks.push(current.trim());
      current = '';
    }
    current += mention;
  }
  if (current.trim().length) chunks.push(current.trim());
  return chunks.length ? chunks : [prefix.trim()];
}

// ================= Ветки отчётов (!ветка) =================
//
// Использование:
//  1. Публикуется сообщение со списком участников — ОБЯЗАТЕЛЬНО тегами (@юзер), не фото/картинкой.
//  2. Под этим сообщением (ответом на него) пишется: "!ветка <любое название>"
//     (название может быть любым, например "2026-10-8-6 7x7 21:58" или просто "Забив №4").
//  3. Бот создаёт ветку (тред) от этого сообщения и тегает туда всех, кто был упомянут в списке.
//  4. Первое сообщение в ветке — эмбед со статусом (кто залил / кто нет).
//  5. Внутри ветки создатель может править состав: "+ @юзер" (добавить) / "- @юзер" (убрать).
//  6. Отчёт — сообщение со ссылкой, начинающейся с "https://". Как только он пришёл — участник
//     отмечается залившим, эмбед обновляется.
//  7. Если ссылка неправильная (не https, либо кинули файл/скрин вместо ссылки) — бот тегает
//     автора и пишет, что отчёт не засчитан.
//  8. Каждый час бот тегает в ветке тех, кто ещё не залил.
//  9. Когда залили все — ветка НЕ закрывается, бот только тегает FINAL_PING_USER_IDS.

function getUnsubmittedParticipants(branch) {
  return branch.participants.filter((p) => !p.submitted);
}

function chunkTextLines(lines, limit = 1000) {
  let chunk = '';
  const chunks = [];
  for (const line of lines) {
    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function buildBranchEmbed(branch) {
  const total = branch.participants.length;
  const submittedCount = branch.participants.filter((p) => p.submitted).length;
  const allDone = total > 0 && submittedCount === total;

  const lines = branch.participants.length
    ? branch.participants.map((p) =>
        p.submitted
          ? `✅ <@${p.id}> — [отчёт](${p.link})`
          : `❌ <@${p.id}> — не залито`
      )
    : ['_список пуст — добавь участников через "+ @юзер"_'];

  const fields = [
    { name: '📌 Статус', value: allDone ? '✅ Все залили' : `🟡 В процессе`, inline: true },
    { name: '📊 Залито', value: `${submittedCount} / ${total}`, inline: true },
    { name: '⏳ Осталось', value: `${total - submittedCount}`, inline: true },
    { name: '👑 Создал', value: `<@${branch.creatorId}>`, inline: true },
    { name: '🕐 Создана', value: `<t:${branch.createdAt}:R>`, inline: true },
  ];

  chunkTextLines(lines).forEach((val, i) => {
    fields.push({
      name: i === 0 ? '📋 Участники' : '\u200b',
      value: val,
    });
  });

  return new EmbedBuilder()
    .setTitle(`🎥 Ветка отчётов: ${branch.name}`)
    .setColor(allDone ? 0x57f287 : 0xf1c40f)
    .addFields(fields)
    .setFooter({ text: `ID ветки: ${branch.id} · отчёт = ссылка, начинающаяся с https://` })
    .setTimestamp();
}

async function updateBranchStatusMessage(guild, branch) {
  if (!branch.statusMessageId) return;
  try {
    const thread = await guild.channels.fetch(branch.threadId);
    const msg = await thread.messages.fetch(branch.statusMessageId);
    await msg.edit({ embeds: [buildBranchEmbed(branch)] });
  } catch (e) {
    console.error('Не удалось обновить эмбед ветки отчётов:', e);
  }
}

async function sendBranchReminder(client, branch) {
  try {
    const guild = await client.guilds.fetch(branch.guildId).catch(() => null);
    if (!guild) return;
    const thread = await guild.channels.fetch(branch.threadId).catch(() => null);
    if (!thread) {
      // ветку удалили вручную — останавливаем таймер
      clearInterval(branchIntervals.get(branch.id));
      branchIntervals.delete(branch.id);
      return;
    }

    const unsubmitted = getUnsubmittedParticipants(branch);
    if (unsubmitted.length === 0) return; // ждать нечего — просто молчим до следующей проверки

    const chunks = chunkMentions(
      unsubmitted.map((p) => p.id),
      '⏰ Ждём отчёт (ссылку, начинающуюся с https://) от:\n'
    );
    for (const chunk of chunks) {
      await thread.send({ content: chunk }).catch(() => {});
    }
  } catch (e) {
    console.error('Ошибка почасового напоминания по ветке отчётов:', e);
  }
}

function scheduleBranchReminders(client, branch) {
  const existing = branchIntervals.get(branch.id);
  if (existing) clearInterval(existing);
  const handle = setInterval(() => sendBranchReminder(client, branch), REPORT_REMINDER_MS);
  branchIntervals.set(branch.id, handle);
}

async function handleBranchAllSubmitted(thread, branch) {
  if (branch.allSubmittedAnnounced) return;
  branch.allSubmittedAnnounced = true;
  saveBranches(branches);
  const pings = FINAL_PING_USER_IDS.map((id) => `<@${id}>`).join(' ');
  await thread
    .send({ content: `${pings} ✅ В ветке «${branch.name}» все залили отчёты.` })
    .catch(() => {});
}

// Создание ветки: "!ветка <название>" ответом на сообщение со списком (тегами).
async function tryCreateBranch(message) {
  const raw = message.content.trim();
  const lower = raw.toLowerCase();
  const cmdLower = BRANCH_COMMAND.toLowerCase();
  if (!lower.startsWith(cmdLower)) return false;

  const name = raw.slice(BRANCH_COMMAND.length).trim();
  if (!name) {
    await message.reply({ content: `⚠️ Укажи название ветки: \`${BRANCH_COMMAND} 2026-10-8-6 7x7 21:58\`` });
    return true;
  }

  if (!message.reference) {
    await message.reply({
      content: '⚠️ Команду нужно писать ОТВЕТОМ на сообщение со списком участников (тегами, не фото).',
    });
    return true;
  }

  let listMessage;
  try {
    listMessage = await message.channel.messages.fetch(message.reference.messageId);
  } catch (e) {
    await message.reply({ content: '⚠️ Не удалось найти сообщение со списком, на которое ты ответил.' });
    return true;
  }

  const mentionedUsers = [...listMessage.mentions.users.values()].filter((u) => !u.bot);
  if (mentionedUsers.length === 0) {
    await message.reply({
      content:
        '⚠️ В сообщении со списком нет тегов участников. Список нужно оформлять тегами (@юзер), а не фото/картинкой.',
    });
    return true;
  }

  let thread;
  try {
    thread = await listMessage.startThread({
      name: name.slice(0, 100),
      autoArchiveDuration: 1440,
      reason: `Ветка отчётов "${name}", создана ${message.author.tag}`,
    });
    await Promise.all(
      mentionedUsers.map((u) => thread.members.add(u.id).catch(() => {}))
    );
    await thread.members.add(message.author.id).catch(() => {});
  } catch (e) {
    console.error('Ошибка создания ветки отчётов:', e);
    await message.reply({
      content:
        `⚠️ Не удалось создать ветку: ${e.message || e}.\n` +
        'Проверь, что у бота есть права «Создавать публичные ветки» и «Управлять ветками» в этом канале.',
    });
    return true;
  }

  const branch = {
    id: thread.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    threadId: thread.id,
    name,
    creatorId: message.author.id,
    createdAt: Math.floor(Date.now() / 1000),
    participants: mentionedUsers.map((u) => ({ id: u.id, submitted: false, link: null, submittedAt: null })),
    statusMessageId: null,
    allSubmittedAnnounced: false,
  };

  const statusMsg = await thread.send({ embeds: [buildBranchEmbed(branch)] });
  branch.statusMessageId = statusMsg.id;
  await statusMsg.pin().catch(() => {});

  branches.set(branch.id, branch);
  saveBranches(branches);
  scheduleBranchReminders(message.client, branch);

  const tagChunks = chunkMentions(
    mentionedUsers.map((u) => u.id),
    '🎥 Ветка отчётов создана. Как заливёте отчёт — киньте сюда ссылку, начинающуюся с https://\n'
  );
  for (const chunk of tagChunks) {
    await thread.send({ content: chunk }).catch(() => {});
  }

  await message.reply({ content: `✅ Ветка «${name}» создана: ${thread.toString()}` }).catch(() => {});
  return true;
}

// "+ @юзер" / "- @юзер" внутри ветки — правит состав (только создатель ветки).
async function tryManageBranchParticipants(message, branch) {
  const raw = message.content.trim();
  const sign = raw[0];
  if (sign !== '+' && sign !== '-') return false;

  const rest = raw.slice(1).trim();
  if (!rest) return false;

  if (message.author.id !== branch.creatorId) {
    const warn = await message.reply({ content: '⛔ Менять состав ветки может только тот, кто её создал.' });
    setTimeout(() => warn.delete().catch(() => {}), 5000);
    await message.delete().catch(() => {});
    return true;
  }

  const mentionedUsers = [...message.mentions.users.values()].filter((u) => !u.bot);
  if (mentionedUsers.length === 0) return false;

  let changed = false;
  if (sign === '+') {
    for (const u of mentionedUsers) {
      if (!branch.participants.some((p) => p.id === u.id)) {
        branch.participants.push({ id: u.id, submitted: false, link: null, submittedAt: null });
        changed = true;
      }
    }
    branch.allSubmittedAnnounced = false;
    await Promise.all(mentionedUsers.map((u) => message.channel.members?.add(u.id).catch(() => {})));
  } else {
    const removeIds = new Set(mentionedUsers.map((u) => u.id));
    const before = branch.participants.length;
    branch.participants = branch.participants.filter((p) => !removeIds.has(p.id));
    changed = branch.participants.length !== before;
  }

  if (!changed) {
    const info = await message.reply({ content: 'ℹ️ Ничего не изменилось.' });
    setTimeout(() => info.delete().catch(() => {}), 5000);
    return true;
  }

  saveBranches(branches);
  await updateBranchStatusMessage(message.guild, branch);

  const confirm = await message.reply({
    content:
      sign === '+'
        ? `➕ Добавлены: ${mentionedUsers.map((u) => `<@${u.id}>`).join(', ')}`
        : `➖ Убраны: ${mentionedUsers.map((u) => `<@${u.id}>`).join(', ')}`,
  });
  setTimeout(() => confirm.delete().catch(() => {}), 5000);

  if (getUnsubmittedParticipants(branch).length === 0 && branch.participants.length > 0) {
    await handleBranchAllSubmitted(message.channel, branch);
  }

  return true;
}

// Похоже, что человек пытался залить отчёт (кинул ссылку не того вида или файл/скрин
// напрямую), но валидной https-ссылки в сообщении нет.
function looksLikeInvalidReportAttempt(message) {
  if (message.content.match(/https:\/\/\S+/)) return false; // это уже валидный отчёт
  const hasBadLink = /(^|\s)(http:\/\/|www\.)\S+/i.test(message.content);
  const hasMedia = message.attachments.size > 0; // видео/фото/файл вложением, без ссылки
  return hasBadLink || hasMedia;
}

// Вложение с видео (файлом, не ссылкой) — такие бот удаляет из ветки, отчёт принимается
// только ссылкой. Требуется право «Управлять сообщениями» в ветке.
function hasVideoAttachment(message) {
  return message.attachments.some((a) => {
    if (a.contentType && a.contentType.startsWith('video/')) return true;
    return /\.(mp4|mov|webm|mkv|avi|m4v|3gp|flv)$/i.test(a.name || '');
  });
}

// Ссылка, начинающаяся с https:// внутри ветки — засчитываем как залитый отчёт.
// Если участник явно пытался залить отчёт, но ссылка неправильная (не https, либо
// прислал файл/скрин вместо ссылки) — бот тегает его и пишет, что не засчитано.
// Видеофайлы вложением бот в любом случае удаляет — отчёт принимается только ссылкой.
async function tryRegisterBranchReport(message, branch) {
  const participant = branch.participants.find((p) => p.id === message.author.id);
  if (!participant) return false;

  const match = message.content.match(/https:\/\/\S+/);
  const videoAttached = hasVideoAttachment(message);

  if (match) {
    participant.submitted = true;
    participant.link = match[0];
    participant.submittedAt = Math.floor(Date.now() / 1000);
    saveBranches(branches);

    if (videoAttached) {
      // Ссылка принята, но видео вложением всё равно удаляем — только ссылки.
      await message.delete().catch(() => {});
      await message.channel
        .send({
          content: `🗑️ <@${message.author.id}>, ссылка принята, видеофайл вложением удалён — заливай отчёт только ссылкой.`,
        })
        .catch(() => {});
    } else {
      await message.react('✅').catch(() => {});
    }

    await updateBranchStatusMessage(message.guild, branch);
    if (getUnsubmittedParticipants(branch).length === 0) {
      await handleBranchAllSubmitted(message.channel, branch);
    }
    return true;
  }

  if (videoAttached) {
    await message.delete().catch(() => {});
    await message.channel
      .send({
        content: `❌ <@${message.author.id}>, видеофайл вложением удалён и отчёт не засчитан — нужна ссылка, начинающаяся с \`https://\`.`,
      })
      .catch(() => {});
    return true;
  }

  if (looksLikeInvalidReportAttempt(message)) {
    await message.react('❌').catch(() => {});
    await message
      .reply({
        content: `❌ <@${message.author.id}>, отчёт не засчитан — нужна ссылка, начинающаяся с \`https://\`.`,
      })
      .catch(() => {});
    return true;
  }

  return false;
}

// Единая точка входа для сообщений, связанных с ветками отчётов. Возвращает true, если
// сообщение было обработано (дальше в messageCreate идти не нужно).
async function handleBranchMessage(message) {
  const lower = message.content.trim().toLowerCase();
  if (lower.startsWith(BRANCH_COMMAND.toLowerCase())) {
    return tryCreateBranch(message);
  }

  const branch = branches.get(message.channelId);
  if (!branch) return false;

  const sign = message.content.trim()[0];
  if (sign === '+' || sign === '-') {
    const handled = await tryManageBranchParticipants(message, branch);
    if (handled) return true;
  }

  return tryRegisterBranchReport(message, branch);
}

function getUnassignedParticipants(list) {
  if (!list.positionsCount) return [];
  const assigned = new Set((list.positions || []).filter(Boolean));
  return (list.participants || []).filter((id) => !assigned.has(id));
}

// Участники списка, которых нет среди тех, кто сейчас сидит в указанном голосовом канале.
function getParticipantsNotInVoice(list, voiceChannel) {
  const inVoice = voiceChannel.members; // Collection<userId, GuildMember>
  return (list.participants || []).filter((id) => !inVoice.has(id));
}

async function pingUnassignedParticipants(channel, list) {
  const unassigned = getUnassignedParticipants(list);
  if (!unassigned.length) {
    return { sent: false, reason: 'none' };
  }
  const chunks = chunkMentions(unassigned, '⚠️ Ещё не заняли позицию: ');
  for (const chunk of chunks) {
    await channel.send({ content: chunk });
  }
  return { sent: true, count: unassigned.length };
}

async function syncThreadMembers(guild, list, addedId, removedId) {
  if (!list.threadId) return;
  try {
    const thread = await guild.channels.fetch(list.threadId);
    if (!thread) return;
    if (addedId) await thread.members.add(addedId).catch(() => {});
    if (removedId) await thread.members.remove(removedId).catch(() => {});
  } catch (e) {
    console.error('Ошибка синхронизации ветки:', e);
  }
}

// ---------- Кастомные голосовые комнаты ----------
const VOICE_REGIONS = [
  { label: 'Автоматически', value: 'automatic' },
  { label: 'Россия', value: 'russia' },
  { label: 'Роттердам (Европа)', value: 'rotterdam' },
  { label: 'США (восток)', value: 'us-east' },
  { label: 'США (запад)', value: 'us-west' },
  { label: 'США (центр)', value: 'us-central' },
  { label: 'США (юг)', value: 'us-south' },
  { label: 'Сингапур', value: 'singapore' },
  { label: 'Япония', value: 'japan' },
  { label: 'Южная Корея', value: 'south-korea' },
  { label: 'Индия', value: 'india' },
  { label: 'Гонконг', value: 'hongkong' },
  { label: 'Сидней', value: 'sydney' },
  { label: 'Бразилия', value: 'brazil' },
  { label: 'ЮАР', value: 'southafrica' },
];

function defaultRoomState(ownerId, guildId) {
  return {
    ownerId,
    guildId,
    locked: false,
    chatEnabled: true,
    waitingRoomEnabled: false,
    waitingChannelId: null,
    trusted: [],
    blocked: [],
    region: null,
  };
}

// Пересчитывает права канала с нуля каждый раз — так они никогда не «расползаются».
function computeRoomOverwrites(guild, room) {
  const map = new Map();
  const ensure = (id) => {
    if (!map.has(id)) map.set(id, { id, allow: new Set(), deny: new Set() });
    return map.get(id);
  };

  const everyone = ensure(guild.roles.everyone.id);
  if (room.locked) everyone.deny.add(PermissionFlagsBits.Connect);
  if (!room.chatEnabled) everyone.deny.add(PermissionFlagsBits.SendMessages);

  const owner = ensure(room.ownerId);
  [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.DeafenMembers,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.ViewChannel,
  ].forEach((p) => owner.allow.add(p));

  for (const uid of room.trusted) {
    if (uid === room.ownerId) continue;
    const e = ensure(uid);
    e.allow.add(PermissionFlagsBits.Connect);
    e.allow.add(PermissionFlagsBits.ViewChannel);
  }

  for (const uid of room.blocked) {
    const e = ensure(uid);
    e.allow.delete(PermissionFlagsBits.Connect);
    e.allow.delete(PermissionFlagsBits.ViewChannel);
    e.deny.add(PermissionFlagsBits.Connect);
    e.deny.add(PermissionFlagsBits.ViewChannel);
  }

  return Array.from(map.values()).map(({ id, allow, deny }) => ({
    id,
    allow: Array.from(allow),
    deny: Array.from(deny),
  }));
}

async function applyRoomPermissions(guild, channel, room) {
  try {
    await channel.permissionOverwrites.set(computeRoomOverwrites(guild, room));
  } catch (e) {
    console.error('Ошибка применения прав комнаты:', e);
  }
}

function buildVoicePanelEmbed(member, room) {
  return new EmbedBuilder()
    .setTitle('🔊 Твоя голосовая комната')
    .setColor(0x9b59b6)
    .setDescription(
      `📌 Приватность: ${room.locked ? '🔒 закрыта' : '🔓 открыта'}\n` +
        `⏳ Зал ожидания: ${room.waitingRoomEnabled ? 'включён' : 'выключен'}\n` +
        `💬 Чат: ${room.chatEnabled ? 'включён' : 'выключен'}\n` +
        `🌍 Регион: ${room.region || 'автоматически'}\n\n` +
        'Управляй комнатой кнопками ниже 👇'
    )
    .setFooter({ text: `Владелец: ${member.displayName}` })
    .setTimestamp();
}

function buildVoicePanelRows(roomId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('voice', 'rename', roomId)).setLabel('Название').setEmoji(EMOJI.voiceRename).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('voice', 'limit', roomId)).setLabel('Лимит').setEmoji(EMOJI.voiceLimit).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('voice', 'privacy', roomId)).setLabel('Приватность').setEmoji(EMOJI.voicePrivacy).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'waitingroom', roomId)).setLabel('Зал ожидания').setEmoji(EMOJI.voiceWaitingRoom).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'chat', roomId)).setLabel('Чат').setEmoji(EMOJI.voiceChat).setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('voice', 'trust', roomId)).setLabel('Доверить').setEmoji(EMOJI.voiceTrust).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('voice', 'untrust', roomId)).setLabel('Не доверять').setEmoji(EMOJI.voiceUntrust).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'invite', roomId)).setLabel('Пригласить').setEmoji(EMOJI.voiceInvite).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('voice', 'kick', roomId)).setLabel('Кикнуть').setEmoji(EMOJI.voiceKick).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cid('voice', 'region', roomId)).setLabel('Регион').setEmoji(EMOJI.voiceRegion).setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('voice', 'block', roomId)).setLabel('Заблокировать').setEmoji(EMOJI.voiceBlock).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cid('voice', 'unblock', roomId)).setLabel('Разблокировать').setEmoji(EMOJI.voiceUnblock).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'claim', roomId)).setLabel('Забрать права').setEmoji(EMOJI.voiceClaim).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'transfer', roomId)).setLabel('Передать права').setEmoji(EMOJI.voiceTransfer).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'delete', roomId)).setLabel('Удалить').setEmoji(EMOJI.voiceDelete).setStyle(ButtonStyle.Danger)
  );
  return [row1, row2, row3];
}

async function createVoiceRoom(guild, member, config) {
  const channelName = `🔊 ${member.displayName}`.slice(0, 100);
  const room = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildVoice,
    parent: config.categoryId,
  });

  voiceData.rooms[room.id] = defaultRoomState(member.id, guild.id);
  saveVoiceData(voiceData);
  await applyRoomPermissions(guild, room, voiceData.rooms[room.id]);

  await member.voice.setChannel(room).catch((e) => {
    console.error('Не удалось переместить пользователя в новую комнату:', e);
  });

  await room
    .send({
      embeds: [buildVoicePanelEmbed(member, voiceData.rooms[room.id])],
      components: buildVoicePanelRows(room.id),
    })
    .catch((e) => console.error('Не удалось отправить панель управления комнатой:', e));
}

async function refreshVoicePanel(guild, roomId) {
  const room = voiceData.rooms[roomId];
  if (!room) return;
  try {
    const channel = await guild.channels.fetch(roomId).catch(() => null);
    if (!channel) return;
    const messages = await channel.messages.fetch({ limit: 20 });
    const panelMsg = messages.find((m) => m.author.id === client.user.id && m.embeds.length);
    const owner = await guild.members.fetch(room.ownerId).catch(() => null);
    if (panelMsg && owner) {
      await panelMsg.edit({
        embeds: [buildVoicePanelEmbed(owner, room)],
        components: buildVoicePanelRows(roomId),
      });
    }
  } catch (e) {
    console.error('Не удалось обновить панель комнаты:', e);
  }
}

async function requireOwner(interaction, roomId) {
  const room = voiceData.rooms[roomId];
  if (!room) {
    await interaction.reply({ content: '⚠️ Эта комната больше не отслеживается.', flags: MessageFlags.Ephemeral });
    return null;
  }
  if (room.ownerId !== interaction.user.id) {
    await interaction.reply({ content: '⛔ Управлять комнатой может только её владелец.', flags: MessageFlags.Ephemeral });
    return null;
  }
  return room;
}

async function handleVoiceButton(interaction) {
  const parts = parseCid(interaction.customId);
  const action = parts[1];
  const roomId = parts[2];

  const guild = interaction.guild;
  const channel = await guild.channels.fetch(roomId).catch(() => null);
  if (!channel) {
    delete voiceData.rooms[roomId];
    saveVoiceData(voiceData);
    await interaction.reply({ content: '⚠️ Комната уже не существует.', flags: MessageFlags.Ephemeral });
    return;
  }

  // "Забрать права" доступно не только владельцу — обрабатываем отдельно.
  if (action === 'claim') {
    const room = voiceData.rooms[roomId];
    if (!room) {
      await interaction.reply({ content: '⚠️ Эта комната больше не отслеживается.', flags: MessageFlags.Ephemeral });
      return;
    }
    const clicker = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!clicker || clicker.voice.channelId !== roomId) {
      await interaction.reply({ content: '⚠️ Чтобы забрать права, нужно находиться в этой комнате.', flags: MessageFlags.Ephemeral });
      return;
    }
    const ownerMember = await guild.members.fetch(room.ownerId).catch(() => null);
    if (ownerMember && ownerMember.voice.channelId === roomId) {
      await interaction.reply({ content: 'ℹ️ Владелец сейчас в комнате, забрать права нельзя.', flags: MessageFlags.Ephemeral });
      return;
    }
    room.ownerId = interaction.user.id;
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await refreshVoicePanel(guild, roomId);
    await interaction.reply({ content: '✅ Ты стал(а) владельцем комнаты.', flags: MessageFlags.Ephemeral });
    return;
  }

  const room = await requireOwner(interaction, roomId);
  if (!room) return;

  if (action === 'rename') {
    const modal = new ModalBuilder().setCustomId(cid('voice', 'renamemodal', roomId)).setTitle('Переименовать комнату');
    const input = new TextInputBuilder()
      .setCustomId('name')
      .setLabel('Новое название')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (action === 'limit') {
    const modal = new ModalBuilder().setCustomId(cid('voice', 'limitmodal', roomId)).setTitle('Лимит участников');
    const input = new TextInputBuilder()
      .setCustomId('limit')
      .setLabel('Число участников (0 = без лимита)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(3);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  if (action === 'privacy') {
    room.locked = !room.locked;
    if (!room.locked && room.waitingRoomEnabled) {
      // Без приватности зал ожидания смысла не имеет — выключаем вместе с ним.
      room.waitingRoomEnabled = false;
      if (room.waitingChannelId) {
        await guild.channels.fetch(room.waitingChannelId).then((c) => c && c.delete().catch(() => {})).catch(() => {});
        delete voiceData.waitingRooms[room.waitingChannelId];
        room.waitingChannelId = null;
      }
    }
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await refreshVoicePanel(guild, roomId);
    await interaction.reply({
      content: room.locked ? '🔒 Комната закрыта для новых людей.' : '🔓 Комната снова открыта.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'waitingroom') {
    if (!room.locked) {
      await interaction.reply({
        content: '⚠️ Сначала включи «Приватность», зал ожидания работает только для закрытой комнаты.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!room.waitingRoomEnabled) {
      const parentId = channel.parentId;
      const owner = await guild.members.fetch(room.ownerId).catch(() => null);
      const waitChannel = await guild.channels.create({
        name: `🕐 Ожидание: ${owner ? owner.displayName : 'комната'}`.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: parentId || undefined,
      });
      room.waitingRoomEnabled = true;
      room.waitingChannelId = waitChannel.id;
      voiceData.waitingRooms[waitChannel.id] = roomId;
      saveVoiceData(voiceData);
      await interaction.reply({
        content: `⏳ Зал ожидания включён: ${waitChannel.toString()}. Заходящих туда я буду присылать тебе на согласование.`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      room.waitingRoomEnabled = false;
      if (room.waitingChannelId) {
        await guild.channels
          .fetch(room.waitingChannelId)
          .then((c) => c && c.delete().catch(() => {}))
          .catch(() => {});
        delete voiceData.waitingRooms[room.waitingChannelId];
        room.waitingChannelId = null;
      }
      saveVoiceData(voiceData);
      await interaction.reply({ content: '⏳ Зал ожидания выключен.', flags: MessageFlags.Ephemeral });
    }
    await refreshVoicePanel(guild, roomId);
    return;
  }

  if (action === 'chat') {
    room.chatEnabled = !room.chatEnabled;
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await refreshVoicePanel(guild, roomId);
    await interaction.reply({
      content: room.chatEnabled ? '💬 Чат в комнате включён.' : '💬 Чат в комнате выключен.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    action === 'trust' ||
    action === 'untrust' ||
    action === 'invite' ||
    action === 'kick' ||
    action === 'block' ||
    action === 'unblock' ||
    action === 'transfer'
  ) {
    const labelMap = {
      trust: 'Кого доверить (сможет заходить в закрытую комнату)',
      untrust: 'У кого забрать доверие',
      invite: 'Кого пригласить (сразу получит доступ)',
      kick: 'Кого выгнать из комнаты',
      block: 'Кого заблокировать (не сможет зайти совсем)',
      unblock: 'Кого разблокировать',
      transfer: 'Кому передать управление комнатой',
    };
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('voice', `select${action}`, roomId))
      .setPlaceholder(labelMap[action])
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'region') {
    const select = new StringSelectMenuBuilder()
      .setCustomId(cid('voice', 'selectregion', roomId))
      .setPlaceholder('Выберите регион голосового сервера')
      .addOptions(VOICE_REGIONS.map((r) => ({ label: r.label, value: r.value })));
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'delete') {
    if (room.waitingChannelId) {
      await guild.channels
        .fetch(room.waitingChannelId)
        .then((c) => c && c.delete().catch(() => {}))
        .catch(() => {});
      delete voiceData.waitingRooms[room.waitingChannelId];
    }
    delete voiceData.rooms[roomId];
    saveVoiceData(voiceData);
    await interaction.reply({ content: '🗑️ Комната будет удалена.', flags: MessageFlags.Ephemeral });
    await channel.delete().catch(() => {});
    return;
  }

  // Принятие/отклонение заявки из зала ожидания
  if (action === 'waitaccept' || action === 'waitdecline') {
    const targetId = parts[3];
    if (action === 'waitaccept') {
      if (!room.trusted.includes(targetId)) room.trusted.push(targetId);
      saveVoiceData(voiceData);
      await applyRoomPermissions(guild, channel, room);
      const targetMember = await guild.members.fetch(targetId).catch(() => null);
      if (targetMember && room.waitingChannelId && targetMember.voice.channelId === room.waitingChannelId) {
        await targetMember.voice.setChannel(channel).catch(() => {});
      }
      await interaction.update({ content: `✅ <@${targetId}> принят(а) в комнату.`, components: [] });
    } else {
      const targetMember = await guild.members.fetch(targetId).catch(() => null);
      if (targetMember && room.waitingChannelId && targetMember.voice.channelId === room.waitingChannelId) {
        await targetMember.voice.disconnect().catch(() => {});
      }
      await interaction.update({ content: `🚫 Заявке <@${targetId}> отказано.`, components: [] });
    }
    return;
  }
}

async function handleVoiceUserSelect(interaction) {
  const parts = parseCid(interaction.customId);
  const action = parts[1];
  const roomId = parts[2];
  const targetId = interaction.values[0];

  const guild = interaction.guild;
  const channel = await guild.channels.fetch(roomId).catch(() => null);
  if (!channel) {
    delete voiceData.rooms[roomId];
    saveVoiceData(voiceData);
    await interaction.update({ content: '⚠️ Комната уже не существует.', components: [] });
    return;
  }

  const room = voiceData.rooms[roomId];
  if (!room) {
    await interaction.update({ content: '⚠️ Эта комната больше не отслеживается.', components: [] });
    return;
  }
  if (room.ownerId !== interaction.user.id) {
    await interaction.reply({ content: '⛔ Управлять комнатой может только её владелец.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'selecttrust') {
    if (!room.trusted.includes(targetId)) room.trusted.push(targetId);
    room.blocked = room.blocked.filter((id) => id !== targetId);
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await interaction.update({ content: `✅ <@${targetId}> теперь может заходить в закрытую комнату.`, components: [] });
    return;
  }

  if (action === 'selectuntrust') {
    room.trusted = room.trusted.filter((id) => id !== targetId);
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await interaction.update({ content: `✅ Доверие <@${targetId}> снято.`, components: [] });
    return;
  }

  if (action === 'selectinvite') {
    if (!room.trusted.includes(targetId)) room.trusted.push(targetId);
    room.blocked = room.blocked.filter((id) => id !== targetId);
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (targetMember && targetMember.voice.channelId) {
      await targetMember.voice.setChannel(channel).catch(() => {});
    }
    await interaction.update({ content: `📨 <@${targetId}> приглашён(а) в комнату.`, components: [] });
    return;
  }

  if (action === 'selectkick') {
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (!member || member.voice.channelId !== roomId) {
      await interaction.update({ content: 'Этого пользователя нет в комнате.', components: [] });
      return;
    }
    await member.voice.disconnect().catch(() => {});
    await interaction.update({ content: `🥾 <@${targetId}> выгнан(а) из комнаты.`, components: [] });
    return;
  }

  if (action === 'selectblock') {
    if (!room.blocked.includes(targetId)) room.blocked.push(targetId);
    room.trusted = room.trusted.filter((id) => id !== targetId);
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    const member = await guild.members.fetch(targetId).catch(() => null);
    if (member && member.voice.channelId === roomId) {
      await member.voice.disconnect().catch(() => {});
    }
    await interaction.update({ content: `⛔ <@${targetId}> заблокирован(а).`, components: [] });
    return;
  }

  if (action === 'selectunblock') {
    room.blocked = room.blocked.filter((id) => id !== targetId);
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await interaction.update({ content: `♻️ <@${targetId}> разблокирован(а).`, components: [] });
    return;
  }

  if (action === 'selecttransfer') {
    room.ownerId = targetId;
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await refreshVoicePanel(guild, roomId);
    await interaction.update({ content: `✅ Управление комнатой передано <@${targetId}>.`, components: [] });
    return;
  }
}

async function handleVoiceStringSelect(interaction) {
  const parts = parseCid(interaction.customId);
  const action = parts[1];
  const roomId = parts[2];

  const room = await requireOwner(interaction, roomId);
  if (!room) return;

  const guild = interaction.guild;
  const channel = await guild.channels.fetch(roomId).catch(() => null);
  if (!channel) {
    delete voiceData.rooms[roomId];
    saveVoiceData(voiceData);
    await interaction.update({ content: '⚠️ Комната уже не существует.', components: [] });
    return;
  }

  if (action === 'selectregion') {
    const value = interaction.values[0];
    room.region = value === 'automatic' ? null : value;
    saveVoiceData(voiceData);
    try {
      await channel.setRTCRegion(room.region);
      await refreshVoicePanel(guild, roomId);
      const label = VOICE_REGIONS.find((r) => r.value === value)?.label || value;
      await interaction.update({ content: `🌍 Регион установлен: ${label}.`, components: [] });
    } catch (e) {
      await interaction.update({ content: `⚠️ Не удалось задать регион: ${e.message || e}`, components: [] });
    }
    return;
  }
}

async function handleVoiceModalSubmit(interaction) {
  const parts = parseCid(interaction.customId);
  const action = parts[1];
  const roomId = parts[2];

  const room = await requireOwner(interaction, roomId);
  if (!room) return;

  const guild = interaction.guild;
  const channel = await guild.channels.fetch(roomId).catch(() => null);
  if (!channel) {
    delete voiceData.rooms[roomId];
    saveVoiceData(voiceData);
    await interaction.reply({ content: '⚠️ Комната уже не существует.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'renamemodal') {
    const name = interaction.fields.getTextInputValue('name').trim();
    try {
      await channel.setName(name);
      await refreshVoicePanel(guild, roomId);
      await interaction.reply({ content: `✅ Комната переименована в «${name}».`, flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({ content: `⚠️ Не удалось переименовать: ${e.message || e}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }

  if (action === 'limitmodal') {
    const raw = interaction.fields.getTextInputValue('limit').trim();
    if (!/^\d+$/.test(raw) || parseInt(raw, 10) > 99) {
      await interaction.reply({ content: '⚠️ Введите число от 0 до 99 (0 = без лимита).', flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      await channel.setUserLimit(parseInt(raw, 10));
      await interaction.reply({
        content: raw === '0' ? '✅ Лимит участников снят.' : `✅ Лимит участников: ${raw}.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (e) {
      await interaction.reply({ content: `⚠️ Не удалось задать лимит: ${e.message || e}`, flags: MessageFlags.Ephemeral });
    }
    return;
  }
}

// ---------- События ----------
client.once('clientReady', async () => {
  console.log(`Вошёл как ${client.user.tag}`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch();
    console.log(`Кэш участников гильдии прогрет: ${guild.members.cache.size} участников.`);
  } catch (e) {
    console.error('Не удалось прогреть кэш участников гильдии:', e);
  }

  try {
    await registerCommands();
  } catch (e) {
    console.error('Ошибка регистрации команд:', e);
  }

  try {
    await startTelegramForwarder(client);
  } catch (e) {
    console.error('Ошибка запуска пересылки Telegram → Discord:', e);
  }

  // Чистим комнаты, которые исчезли, пока бот был офлайн
  for (const [channelId, room] of Object.entries(voiceData.rooms)) {
    try {
      const guild = await client.guilds.fetch(room.guildId).catch(() => null);
      const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
      if (!channel) {
        delete voiceData.rooms[channelId];
        continue;
      }
      const humanMembers = channel.members.filter((m) => !m.user.bot);
      if (humanMembers.size === 0) {
        await channel.delete().catch(() => {});
        delete voiceData.rooms[channelId];
      }
    } catch (e) {
      console.error('Ошибка очистки голосовых комнат при запуске:', e);
    }
  }
  // Чистим "осиротевшие" залы ожидания (их комнаты уже удалены)
  for (const [waitChannelId, roomId] of Object.entries(voiceData.waitingRooms)) {
    if (!voiceData.rooms[roomId]) {
      delete voiceData.waitingRooms[waitChannelId];
    }
  }
  saveVoiceData(voiceData);

  // Восстанавливаем почасовые напоминания по веткам отчётов после перезапуска бота.
  for (const branch of branches.values()) {
    scheduleBranchReminders(client, branch);
  }
  console.log(`Восстановлено веток отчётов: ${branches.size}`);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    const config = voiceData.configs[guild.id];

    // Зашёл в триггер-канал — создаём комнату
    if (
      config &&
      newState.channelId === config.triggerChannelId &&
      newState.channelId !== oldState.channelId
    ) {
      await createVoiceRoom(guild, newState.member, config);
    }

    // Зашёл в зал ожидания чужой комнаты — шлём владельцу заявку на согласование
    if (newState.channelId && voiceData.waitingRooms[newState.channelId] && newState.channelId !== oldState.channelId) {
      const roomId = voiceData.waitingRooms[newState.channelId];
      const room = voiceData.rooms[roomId];
      if (room && newState.member.id !== room.ownerId && !room.trusted.includes(newState.member.id)) {
        const roomChannel = await guild.channels.fetch(roomId).catch(() => null);
        if (roomChannel) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(cid('voice', 'waitaccept', roomId, newState.member.id))
              .setLabel('Впустить')
              .setEmoji(EMOJI.confirmYes)
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(cid('voice', 'waitdecline', roomId, newState.member.id))
              .setLabel('Отклонить')
              .setEmoji(EMOJI.confirmNo)
              .setStyle(ButtonStyle.Danger)
          );
          await roomChannel
            .send({ content: `🕐 <@${newState.member.id}> хочет присоединиться к комнате.`, components: [row] })
            .catch(() => {});
        }
      }
    }

    // Вышел из отслеживаемой комнаты — проверяем, не опустела ли она
    if (oldState.channelId && voiceData.rooms[oldState.channelId] && oldState.channelId !== newState.channelId) {
      const channel = oldState.channel || (await guild.channels.fetch(oldState.channelId).catch(() => null));
      if (!channel) {
        delete voiceData.rooms[oldState.channelId];
        saveVoiceData(voiceData);
      } else {
        const humanMembers = channel.members.filter((m) => !m.user.bot);
        if (humanMembers.size === 0) {
          const room = voiceData.rooms[oldState.channelId];
          if (room && room.waitingChannelId) {
            await guild.channels
              .fetch(room.waitingChannelId)
              .then((c) => c && c.delete().catch(() => {}))
              .catch(() => {});
            delete voiceData.waitingRooms[room.waitingChannelId];
          }
          await channel.delete().catch(() => {});
          delete voiceData.rooms[oldState.channelId];
          saveVoiceData(voiceData);
        }
      }
    }
  } catch (e) {
    console.error('Ошибка обработки voiceStateUpdate:', e);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    // Ветки отчётов (!ветка / + @юзер / - @юзер / ссылка-отчёт) — если сообщение
    // относится к ним, дальше по остальным обработчикам не идём.
    if (await handleBranchMessage(message)) return;

    let targetList = null;
    for (const list of lists.values()) {
      if (list.threadId === message.channelId) {
        targetList = list;
        break;
      }
    }
    if (!targetList || !targetList.positionsCount) return;

    const raw = message.content.trim();
    if (!/^\d+$/.test(raw)) return; // это не попытка занять позицию — не трогаем сообщение

    const pos = parseInt(raw, 10);

    if (pos < 1 || pos > targetList.positionsCount) {
      const warn = await message.reply({
        content: `⚠️ Номер позиции должен быть от 1 до ${targetList.positionsCount}.`,
      });
      await message.delete().catch(() => {});
      setTimeout(() => warn.delete().catch(() => {}), 5000);
      return;
    }

    const occupant = targetList.positions[pos - 1];

    if (occupant === message.author.id) {
      const info = await message.reply({ content: `Вы уже занимаете позицию №${pos}.` });
      await message.delete().catch(() => {});
      setTimeout(() => info.delete().catch(() => {}), 5000);
      return;
    }

    if (occupant) {
      const warn = await message.reply({ content: `⚠️ Позиция №${pos} уже занята <@${occupant}>.` });
      await message.delete().catch(() => {});
      setTimeout(() => warn.delete().catch(() => {}), 5000);
      return;
    }

    freeUserPosition(targetList, message.author.id);
    targetList.positions[pos - 1] = message.author.id;
    saveLists(lists);

    await updatePositionsMessage(message.guild, targetList);
    await message.delete().catch(() => {});

    const ok = await message.channel.send({ content: `✅ <@${message.author.id}> занял(а) позицию №${pos}.` });
    setTimeout(() => ok.delete().catch(() => {}), 5000);
  } catch (e) {
    console.error('Ошибка обработки занятия позиции по числу:', e);
  }
});

client.on('threadDelete', async (thread) => {
  try {
    for (const list of lists.values()) {
      if (list.threadId === thread.id) {
        list.threadId = null;
        list.positionsMessageId = null;
        saveLists(lists);
        await updateListMessage(thread.guild, list).catch(() => {});
        break;
      }
    }
  } catch (e) {
    console.error('Ошибка обработки threadDelete:', e);
  }
});

// Discord даёт всего ~3 сек на первый ответ на interaction. Если бот в этот момент был
// занят/перезапускался (например, при передеплое) — токен успевает "протухнуть", и ЛЮБАЯ
// попытка ответить (reply/update/deferReply/...) падает с DiscordAPIError 10062 "Unknown
// interaction". Само взаимодействие уже не спасти, но это не баг в логике команды — такие
// ошибки просто гасим здесь одним местом, вместо падения с двойным стектрейсом в логах.
const STALE_INTERACTION_CODES = new Set([10062, 40060, 10008]); // Unknown interaction / already acknowledged / unknown message

function patchInteractionAckMethods(interaction) {
  const methods = ['reply', 'update', 'deferReply', 'deferUpdate', 'followUp', 'editReply', 'showModal'];
  for (const name of methods) {
    if (typeof interaction[name] !== 'function') continue;
    const original = interaction[name].bind(interaction);
    interaction[name] = async (...args) => {
      try {
        return await original(...args);
      } catch (err) {
        if (err && STALE_INTERACTION_CODES.has(err.code)) {
          console.warn(`⚠️ Взаимодействие устарело (код ${err.code}, ${name}) — пропускаю, ответ пользователю не дойдёт.`);
          return null;
        }
        throw err;
      }
    };
  }
}

client.on('interactionCreate', async (interaction) => {
  patchInteractionAckMethods(interaction);
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'wine') {
      await handleWineCommand(interaction);
    } else if (interaction.isChatInputCommand() && interaction.commandName === 'voice-setup') {
      await handleVoiceSetupCommand(interaction);
    } else if (interaction.isButton()) {
      const [prefix] = parseCid(interaction.customId);
      if (prefix === 'voice') {
        await handleVoiceButton(interaction);
      } else {
        await handleButton(interaction);
      }
    } else if (interaction.isUserSelectMenu()) {
      const [prefix] = parseCid(interaction.customId);
      if (prefix === 'voice') {
        await handleVoiceUserSelect(interaction);
      } else {
        await handleUserSelect(interaction);
      }
    } else if (interaction.isStringSelectMenu()) {
      const [prefix] = parseCid(interaction.customId);
      if (prefix === 'voice') {
        await handleVoiceStringSelect(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      const [prefix, action, id] = parseCid(interaction.customId);
      if (prefix === 'voice') {
        await handleVoiceModalSubmit(interaction);
      } else {
        await handleModalSubmit(interaction);
      }
    }
  } catch (err) {
    console.error('Необработанная ошибка:', err);
    await notifyError(interaction, `Произошла ошибка: ${err.message || err}`);
  }
});


async function handleWineCommand(interaction) {
  const title = interaction.options.getString('название');
  const quantityRaw = interaction.options.getString('количество').trim();
  const time = interaction.options.getString('время');
  const role = interaction.options.getRole('роль');

  let quantity;
  if (/^неограничено$/i.test(quantityRaw) || quantityRaw === '∞') {
    quantity = 'Неограничено';
  } else if (/^\d+$/.test(quantityRaw)) {
    quantity = quantityRaw;
  } else {
    await interaction.reply({
      content: '⚠️ Количество должно быть числом или словом «Неограничено».',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  const guild = interaction.guild;
  const listId = genId();
  const list = {
    id: listId,
    guildId: guild.id,
    channelId: interaction.channelId,
    messageId: null,
    creatorId: interaction.user.id,
    title,
    quantity,
    time,
    roleId: role.id,
    participants: [],
    reserve: [],
    admins: [],
    threadId: null,
    positionsCount: null,
    positions: null,
    positionsMessageId: null,
    isOpen: true,
    createdAt: Math.floor(Date.now() / 1000),
  };
  lists.set(listId, list);

  const embed = buildEmbed(list);
  const row = buildMainRow(list);
  const sent = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });
  list.messageId = sent.id;
  saveLists(lists);

  try {
    const targetChannel = interaction.channel;
    const membersWithRole = role.members
      .filter((m) => m.id !== client.user.id)
      .filter((m) => {
        const perms = targetChannel.permissionsFor(m);
        return perms ? perms.has(PermissionFlagsBits.ViewChannel) : false;
      })
      .map((m) => m.id);

    if (!membersWithRole.length) {
      await interaction.followUp({
        content: `ℹ️ У роли **${role.name}** сейчас нет участников — оповещение не отправлено.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const chunks = chunkMentions(
      membersWithRole,
      `📡 Оповещение по роли **${role.name}** — набор «${title}»:\n`
    );
    const channel = interaction.channel;
    for (const chunk of chunks) {
      const msg = await channel.send({
        content: chunk,
        allowedMentions: { users: membersWithRole },
      });
      setTimeout(() => msg.delete().catch(() => {}), 5000);
    }
  } catch (e) {
    console.error('Ошибка при тегании роли:', e);
    await notifyError(
      interaction,
      `Не удалось оповестить роль **${role.name}**: ${e.message || e}. ` +
        'Проверь, что у бота включён Server Members Intent в Discord Developer Portal.'
    );
  }
}

async function handleVoiceSetupCommand(interaction) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: '⛔ Нужны права «Управление сервером».', flags: MessageFlags.Ephemeral });
    return;
  }

  const trigger = interaction.options.getChannel('триггер');
  const category = interaction.options.getChannel('категория');

  if (trigger.type !== ChannelType.GuildVoice) {
    await interaction.reply({ content: '⚠️ Триггер должен быть голосовым каналом.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (category.type !== ChannelType.GuildCategory) {
    await interaction.reply({ content: '⚠️ Категория должна быть именно категорией.', flags: MessageFlags.Ephemeral });
    return;
  }

  voiceData.configs[interaction.guild.id] = {
    triggerChannelId: trigger.id,
    categoryId: category.id,
  };
  saveVoiceData(voiceData);

  await interaction.reply({
    content:
      `✅ Готово! Теперь при заходе в **${trigger.name}** участнику будет создаваться личная голосовая комната в категории **${category.name}**.\n` +
      'Убедись, что у бота есть права «Управление каналами» и «Перемещение участников» на сервере.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleButton(interaction) {
  const [prefix, action, listId] = parseCid(interaction.customId);
  if (prefix !== 'wine') return;
  const list = lists.get(listId);
  if (!list) {
    await interaction.reply({ content: '⚠️ Этот набор больше не существует.', flags: MessageFlags.Ephemeral });
    return;
  }
  const guild = interaction.guild;
  const uid = interaction.user.id;

  if (action === 'join') {
    if (!list.isOpen) {
      await interaction.reply({ content: '🔒 Сбор сейчас закрыт, присоединиться нельзя.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (list.participants.includes(uid)) {
      await interaction.reply({ content: 'Вы уже в основном составе.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (list.reserve.includes(uid)) {
      await interaction.reply({ content: 'Вы уже в резерве.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (isFull(list)) {
      list.reserve.push(uid);
      saveLists(lists);
      await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
      return;
    }
    list.participants.push(uid);
    saveLists(lists);
    await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
    await syncThreadMembers(guild, list, uid, null);
    return;
  }

  if (action === 'leave') {
    if (list.participants.includes(uid)) {
      list.participants = list.participants.filter((id) => id !== uid);
      const posChanged = freeUserPosition(list, uid);
      saveLists(lists);
      await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
      await syncThreadMembers(guild, list, null, uid);
      if (posChanged) await updatePositionsMessage(guild, list);
      return;
    }
    if (list.reserve.includes(uid)) {
      list.reserve = list.reserve.filter((id) => id !== uid);
      saveLists(lists);
      await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
      return;
    }
    await interaction.reply({ content: 'Вы не записаны ни в основной состав, ни в резерв.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'toggleopen') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    list.isOpen = !list.isOpen;
    saveLists(lists);
    await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
    return;
  }

  if (action === 'manage') {
    if (!isManager(list, uid)) {
      await interaction.reply({
        content: '⛔ Только создатель или администратор набора может это делать.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isCreator = list.creatorId === uid;
    const row1Buttons = [];
    if (isCreator) {
      row1Buttons.push(
        new ButtonBuilder()
          .setCustomId(cid('wine', 'addadmin', listId))
          .setLabel('Добавить администратора')
          .setEmoji(EMOJI.addAdmin)
          .setStyle(ButtonStyle.Primary)
      );
    }
    row1Buttons.push(
      new ButtonBuilder()
        .setCustomId(cid('wine', 'addperson', listId))
        .setLabel('Добавить участников')
        .setEmoji(EMOJI.addPerson)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(cid('wine', 'removeperson', listId))
        .setLabel('Удалить участников')
        .setEmoji(EMOJI.removePerson)
        .setStyle(ButtonStyle.Danger)
    );
    await interaction.reply({
      content:
        '🛠️ Панель управления набором:\n' +
        '_«Добавить участников» переносит и людей из резерва — их оттуда уберёт автоматически._',
      components: [new ActionRowBuilder().addComponents(row1Buttons)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === 'addadmin') {
    if (list.creatorId !== uid) {
      await interaction.reply({ content: '⛔ Только создатель набора может это делать.', flags: MessageFlags.Ephemeral });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectaddadmin', listId))
      .setPlaceholder('Выберите пользователя для назначения администратором')
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'addperson') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectaddperson', listId))
      .setPlaceholder('Выберите одного или нескольких пользователей')
      .setMinValues(1)
      .setMaxValues(25);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'removeperson') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectremoveperson', listId))
      .setPlaceholder('Выберите одного или нескольких пользователей')
      .setMinValues(1)
      .setMaxValues(25);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'thread') {
    if (list.threadId) {
      await interaction.reply({ content: `ℹ️ Ветка уже создана: <#${list.threadId}>`, flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder().setCustomId(cid('wine', 'threadmodal', listId)).setTitle('Создать ветку');
    const nameInput = new TextInputBuilder()
      .setCustomId('threadname')
      .setLabel('Название ветки')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(90);
    const positionsInput = new TextInputBuilder()
      .setCustomId('positions')
      .setLabel('Кол-во позиций (число или -)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(10)
      .setPlaceholder('Например: 15, или - если список позиций не нужен');
    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(positionsInput)
    );
    await interaction.showModal(modal);
    return;
  }

  if (action === 'claimposition') {
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(cid('wine', 'claimposmodal', listId))
      .setTitle('Занять позицию');
    const posInput = new TextInputBuilder()
      .setCustomId('position')
      .setLabel(`Номер позиции (1-${list.positionsCount})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(5);
    modal.addComponents(new ActionRowBuilder().addComponents(posInput));
    await interaction.showModal(modal);
    return;
  }

  if (action === 'leaveposition') {
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', flags: MessageFlags.Ephemeral });
      return;
    }
    const changed = freeUserPosition(list, uid);
    if (!changed) {
      await interaction.reply({ content: 'Вы не занимаете ни одной позиции.', flags: MessageFlags.Ephemeral });
      return;
    }
    saveLists(lists);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await updatePositionsMessage(interaction.guild, list);
    await interaction.editReply({ content: '✅ Вы покинули позицию.' });
    return;
  }

  if (action === 'pingunassigned') {
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!list.threadId) {
      await interaction.reply({ content: '⚠️ У этого набора нет ветки.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const thread = await interaction.guild.channels.fetch(list.threadId).catch(() => null);
    if (!thread) {
      await interaction.editReply({ content: '⚠️ Не удалось найти ветку.' });
      return;
    }
    const result = await pingUnassignedParticipants(thread, list);
    if (!result.sent) {
      await interaction.editReply({ content: '✅ Все участники уже заняли позиции.' });
    } else {
      await interaction.editReply({ content: `📣 Отмечено участников без позиции: ${result.count}.` });
    }
    return;
  }

  if (action === 'pingnotinvoice') {
    if (!list.threadId) {
      await interaction.reply({ content: '⚠️ У этого набора нет ветки.', flags: MessageFlags.Ephemeral });
      return;
    }
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({
        content: '⚠️ Вы должны находиться в голосовом канале, чтобы использовать эту кнопку.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const thread = await interaction.guild.channels.fetch(list.threadId).catch(() => null);
    if (!thread) {
      await interaction.editReply({ content: '⚠️ Не удалось найти ветку.' });
      return;
    }
    const notInVoice = getParticipantsNotInVoice(list, voiceChannel);
    if (!notInVoice.length) {
      await interaction.editReply({ content: `✅ Все участники уже в **${voiceChannel.name}**.` });
      return;
    }
    const chunks = chunkMentions(notInVoice, `🔇 Ещё не зашли в войс (${voiceChannel.name}): `);
    for (const chunk of chunks) {
      await thread.send({ content: chunk });
    }
    await interaction.editReply({ content: `📣 Отмечено участников не в войсе: ${notInVoice.length}.` });
    return;
  }

  if (action === 'posmanage') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', flags: MessageFlags.Ephemeral });
      return;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(cid('wine', 'assignposition', listId))
        .setLabel('Назначить участника')
        .setEmoji(EMOJI.assignPosition)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(cid('wine', 'removeposition', listId))
        .setLabel('Снять с позиции')
        .setEmoji(EMOJI.removePosition)
        .setStyle(ButtonStyle.Danger)
    );
    await interaction.reply({ content: '🎖️ Управление позициями:', components: [row], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'assignposition') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectassignpos', listId))
      .setPlaceholder('Выберите пользователя для назначения на позицию')
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'removeposition') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(cid('wine', 'removeposmodal', listId))
      .setTitle('Снять с позиции');
    const posInput = new TextInputBuilder()
      .setCustomId('position')
      .setLabel(`Номер позиции (1-${list.positionsCount})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(5);
    modal.addComponents(new ActionRowBuilder().addComponents(posInput));
    await interaction.showModal(modal);
    return;
  }
}

async function handleUserSelect(interaction) {
  const [prefix, action, listId] = parseCid(interaction.customId);
  if (prefix !== 'wine') return;
  const list = lists.get(listId);
  if (!list) {
    await interaction.update({ content: '⚠️ Набор не найден.', components: [] });
    return;
  }
  if (!isManager(list, interaction.user.id)) {
    await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
    return;
  }

  const guild = interaction.guild;

  if (action === 'selectaddadmin') {
    if (list.creatorId !== interaction.user.id) {
      await interaction.reply({ content: '⛔ Только создатель набора может это делать.', flags: MessageFlags.Ephemeral });
      return;
    }
    const targetId = interaction.values[0];
    if (!list.admins.includes(targetId)) list.admins.push(targetId);
    saveLists(lists);
    await updateListMessage(guild, list);
    await interaction.update({ content: `✅ <@${targetId}> назначен администратором набора.`, components: [] });
    return;
  }

  if (action === 'selectaddperson') {
    const added = [];
    const already = [];
    for (const targetId of interaction.values) {
      if (list.participants.includes(targetId)) {
        already.push(targetId);
        continue;
      }
      list.participants.push(targetId);
      list.reserve = list.reserve.filter((id) => id !== targetId);
      added.push(targetId);
    }
    saveLists(lists);
    const parts = [];
    if (added.length) parts.push(`✅ Добавлены в состав: ${added.map((id) => `<@${id}>`).join(', ')}`);
    if (already.length) parts.push(`ℹ️ Уже были в составе: ${already.map((id) => `<@${id}>`).join(', ')}`);
    // Сначала отвечаем — это то, что видит нажавший кнопку, дальше не должно его тормозить.
    await interaction.update({ content: parts.join('\n') || 'Ничего не изменилось.', components: [] });
    await Promise.all([
      updateListMessage(guild, list),
      ...added.map((targetId) => syncThreadMembers(guild, list, targetId, null)),
    ]);
    return;
  }

  if (action === 'selectremoveperson') {
    const removed = [];
    const notFound = [];
    let anyPosChanged = false;
    for (const targetId of interaction.values) {
      const inParticipants = list.participants.includes(targetId);
      const inReserve = list.reserve.includes(targetId);
      if (!inParticipants && !inReserve) {
        notFound.push(targetId);
        continue;
      }
      if (inParticipants) {
        list.participants = list.participants.filter((id) => id !== targetId);
        if (freeUserPosition(list, targetId)) anyPosChanged = true;
      }
      if (inReserve) {
        list.reserve = list.reserve.filter((id) => id !== targetId);
      }
      removed.push(targetId);
    }
    saveLists(lists);
    const parts = [];
    if (removed.length) parts.push(`🗑️ Удалены: ${removed.map((id) => `<@${id}>`).join(', ')}`);
    if (notFound.length) parts.push(`ℹ️ Не были в списке: ${notFound.map((id) => `<@${id}>`).join(', ')}`);
    // Сначала отвечаем — это то, что видит нажавший кнопку, дальше не должно его тормозить.
    await interaction.update({ content: parts.join('\n') || 'Ничего не изменилось.', components: [] });
    await Promise.all([
      updateListMessage(guild, list),
      anyPosChanged ? updatePositionsMessage(guild, list) : Promise.resolve(),
      ...removed.map((targetId) => syncThreadMembers(guild, list, null, targetId)),
    ]);
    return;
  }

  if (action === 'selectassignpos') {
    if (!list.positionsCount) {
      await interaction.update({ content: '⚠️ В этом наборе нет списка позиций.', components: [] });
      return;
    }
    const targetId = interaction.values[0];
    const modal = new ModalBuilder()
      .setCustomId(cid('wine', 'assignposmodal', listId, targetId))
      .setTitle('Назначить на позицию');
    const posInput = new TextInputBuilder()
      .setCustomId('position')
      .setLabel(`Номер позиции (1-${list.positionsCount})`)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(5);
    modal.addComponents(new ActionRowBuilder().addComponents(posInput));
    await interaction.showModal(modal);
    return;
  }
}

async function handleModalSubmit(interaction) {
  const [prefix, action, listId, extra] = parseCid(interaction.customId);
  if (prefix !== 'wine') return;
  const list = lists.get(listId);
  if (!list) {
    await interaction.reply({ content: '⚠️ Набор не найден.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'threadmodal') {
    const threadName = interaction.fields.getTextInputValue('threadname');
    const positionsRaw = interaction.fields.getTextInputValue('positions').trim();

    let positionsCount = null;
    if (positionsRaw !== '-' && positionsRaw !== '') {
      if (!/^\d+$/.test(positionsRaw) || parseInt(positionsRaw, 10) <= 0) {
        await interaction.reply({
          content: '⚠️ Количество позиций должно быть целым числом больше 0, либо «-» если список позиций не нужен.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      positionsCount = parseInt(positionsRaw, 10);
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const guild = interaction.guild;
      const channel = await guild.channels.fetch(list.channelId);
      const collectionMessage = await channel.messages.fetch(list.messageId);

      const thread = await collectionMessage.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: `Ветка для набора «${list.title}» (${list.id})`,
      });

      list.threadId = thread.id;

      // Добавляем участников в ветку параллельно, а не по одному — на больших составах
      // это давало заметную задержку перед ответом бота.
      await Promise.all(
        list.participants.map((uid) =>
          thread.members.add(uid).catch((e) => {
            console.error(`Не удалось добавить ${uid} в ветку:`, e);
          })
        )
      );

      if (positionsCount) {
        list.positionsCount = positionsCount;
        list.positions = new Array(positionsCount).fill(null);
        const posMsg = await thread.send({
          embeds: [buildPositionsEmbed(list)],
          components: buildPositionsRow(list),
        });
        list.positionsMessageId = posMsg.id;
      }

      saveLists(lists);
      await updateListMessage(guild, list);
      if (positionsCount) await pingUnassignedParticipants(thread, list);

      await interaction.editReply({ content: `✅ Ветка «${threadName}» создана: ${thread.toString()}` });
    } catch (e) {
      console.error('Ошибка создания ветки:', e);
      await interaction.editReply({
        content:
          `⚠️ Не удалось создать ветку: ${e.message || e}.\n` +
          'Проверь, что у бота на сервере есть права «Создавать публичные ветки» и «Управлять ветками» в этом канале.',
      });
    }
    return;
  }

  if (action === 'claimposmodal') {
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', flags: MessageFlags.Ephemeral });
      return;
    }
    const raw = interaction.fields.getTextInputValue('position').trim();
    const pos = parseInt(raw, 10);

    if (!/^\d+$/.test(raw) || pos < 1 || pos > list.positionsCount) {
      await interaction.reply({
        content: `⚠️ Номер позиции должен быть от 1 до ${list.positionsCount}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const occupant = list.positions[pos - 1];
    if (occupant && occupant !== interaction.user.id) {
      await interaction.reply({ content: `⚠️ Позиция №${pos} уже занята <@${occupant}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (occupant === interaction.user.id) {
      await interaction.reply({ content: `Вы уже занимаете позицию №${pos}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    list.positions = list.positions.map((p) => (p === interaction.user.id ? null : p));
    list.positions[pos - 1] = interaction.user.id;
    saveLists(lists);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await updatePositionsMessage(interaction.guild, list);
    await interaction.editReply({ content: `✅ Вы заняли позицию №${pos}.` });
    return;
  }

  if (action === 'assignposmodal') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', flags: MessageFlags.Ephemeral });
      return;
    }
    const targetId = extra;
    const raw = interaction.fields.getTextInputValue('position').trim();
    const pos = parseInt(raw, 10);

    if (!/^\d+$/.test(raw) || pos < 1 || pos > list.positionsCount) {
      await interaction.reply({
        content: `⚠️ Номер позиции должен быть от 1 до ${list.positionsCount}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    list.positions = list.positions.map((p) => (p === targetId ? null : p));
    list.positions[pos - 1] = targetId;
    saveLists(lists);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await updatePositionsMessage(interaction.guild, list);
    await interaction.editReply({ content: `✅ <@${targetId}> назначен на позицию №${pos}.` });
    return;
  }

  if (action === 'removeposmodal') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: '⛔ Нет доступа.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', flags: MessageFlags.Ephemeral });
      return;
    }
    const raw = interaction.fields.getTextInputValue('position').trim();
    const pos = parseInt(raw, 10);

    if (!/^\d+$/.test(raw) || pos < 1 || pos > list.positionsCount) {
      await interaction.reply({
        content: `⚠️ Номер позиции должен быть от 1 до ${list.positionsCount}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!list.positions[pos - 1]) {
      await interaction.reply({ content: `Позиция №${pos} уже свободна.`, flags: MessageFlags.Ephemeral });
      return;
    }

    list.positions[pos - 1] = null;
    saveLists(lists);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await updatePositionsMessage(interaction.guild, list);
    await interaction.editReply({ content: `✅ Позиция №${pos} освобождена.` });
    return;
  }
}

client.login(TOKEN);
