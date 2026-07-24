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
} = require('discord.js');
const { loadLists, saveLists } = require('./storage');
const { loadVoiceData, saveVoiceData } = require('./voicestorage');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Не заданы BOT_TOKEN и/или CLIENT_ID в переменных окружения (.env).');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
});

const lists = loadLists();
const voiceData = loadVoiceData(); // { configs: { guildId: {triggerChannelId, categoryId} }, rooms: { channelId: {ownerId, guildId} } }

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
      await interaction.followUp({ content: `⚠️ ${message}`, ephemeral: true });
    } else {
      await interaction.reply({ content: `⚠️ ${message}`, ephemeral: true });
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
    .setEmoji(full ? '⏳' : '🟢')
    .setStyle(full ? ButtonStyle.Secondary : ButtonStyle.Success)
    .setDisabled(!list.isOpen);

  const leaveBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'leave', list.id))
    .setLabel('Покинуть')
    .setEmoji('🔴')
    .setStyle(ButtonStyle.Danger);

  const manageBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'manage', list.id))
    .setLabel('Управление')
    .setEmoji('🛠️')
    .setStyle(ButtonStyle.Secondary);

  const threadBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'thread', list.id))
    .setLabel(list.threadId ? 'Ветка создана' : 'Создать ветку')
    .setEmoji('🧵')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(Boolean(list.threadId));

  const toggleBtn = new ButtonBuilder()
    .setCustomId(cid('wine', 'toggleopen', list.id))
    .setLabel(list.isOpen ? 'Закрыть сбор' : 'Открыть сбор')
    .setEmoji(list.isOpen ? '🔒' : '🔓')
    .setStyle(list.isOpen ? ButtonStyle.Danger : ButtonStyle.Success);

  return new ActionRowBuilder().addComponents(joinBtn, leaveBtn, manageBtn, threadBtn, toggleBtn);
}

// Отдельный ряд с кнопкой назначения администратора — виден всем под основным сообщением,
// но нажать её результативно может только создатель набора (проверка внутри обработчика).
function buildAdminRow(list) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('wine', 'addadmin', list.id))
      .setLabel('Добавить администратора')
      .setEmoji('🎖️')
      .setStyle(ButtonStyle.Primary)
  );
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
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('wine', 'claimposition', list.id))
      .setLabel('Занять позицию')
      .setEmoji('🙋')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('wine', 'leaveposition', list.id))
      .setLabel('Покинуть позицию')
      .setEmoji('🚪')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('wine', 'posmanage', list.id))
      .setLabel('Управление позициями')
      .setEmoji('🎖️')
      .setStyle(ButtonStyle.Secondary)
  );
}

async function updateListMessage(guild, list) {
  try {
    const channel = await guild.channels.fetch(list.channelId);
    const message = await channel.messages.fetch(list.messageId);
    await message.edit({ embeds: [buildEmbed(list)], components: [buildMainRow(list), buildAdminRow(list)] });
  } catch (e) {
    console.error('Не удалось обновить сообщение набора:', e);
  }
}

async function updatePositionsMessage(guild, list) {
  if (!list.positionsCount || !list.threadId || !list.positionsMessageId) return;
  try {
    const thread = await guild.channels.fetch(list.threadId);
    const message = await thread.messages.fetch(list.positionsMessageId);
    await message.edit({ embeds: [buildPositionsEmbed(list)], components: [buildPositionsRow(list)] });
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

// Новая исправленная функция для разбивки упоминаний с лимитами символов и количества юзеров
function chunkMentions(userIds, prefix) {
  const chunks = [];
  let currentString = prefix;
  let currentUserIds = [];

  for (const id of userIds) {
    const mention = `<@${id}> `;

    // Разбиваем, если превышаем лимит символов (1900)
    // ИЛИ лимит упоминаний в одном сообщении (90, лимит Discord - 100)
    if ((currentString + mention).length > 1900 || currentUserIds.length >= 90) {
      chunks.push({ content: currentString.trim(), users: currentUserIds });
      currentString = '';
      currentUserIds = [];
    }

    currentString += mention;
    currentUserIds.push(id);
  }

  // Добавляем остаток, если он есть
  if (currentString.trim().length) {
    chunks.push({ content: currentString.trim(), users: currentUserIds });
  }

  return chunks.length ? chunks : [{ content: prefix.trim(), users: [] }];
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
    new ButtonBuilder().setCustomId(cid('voice', 'rename', roomId)).setLabel('Название').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('voice', 'limit', roomId)).setLabel('Лимит').setEmoji('👥').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid('voice', 'privacy', roomId)).setLabel('Приватность').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'waitingroom', roomId)).setLabel('Зал ожидания').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'chat', roomId)).setLabel('Чат').setEmoji('💬').setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('voice', 'trust', roomId)).setLabel('Доверить').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('voice', 'untrust', roomId)).setLabel('Не доверять').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'invite', roomId)).setLabel('Пригласить').setEmoji('📨').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(cid('voice', 'kick', roomId)).setLabel('Кикнуть').setEmoji('🥾').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cid('voice', 'region', roomId)).setLabel('Регион').setEmoji('🌍').setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(cid('voice', 'block', roomId)).setLabel('Заблокировать').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cid('voice', 'unblock', roomId)).setLabel('Разблокировать').setEmoji('♻️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'claim', roomId)).setLabel('Забрать права').setEmoji('👑').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'transfer', roomId)).setLabel('Передать права').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(cid('voice', 'delete', roomId)).setLabel('Удалить').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
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
    await interaction.reply({ content: '⚠️ Эта комната больше не отслеживается.', ephemeral: true });
    return null;
  }
  if (room.ownerId !== interaction.user.id) {
    await interaction.reply({ content: '⛔ Управлять комнатой может только её владелец.', ephemeral: true });
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
    await interaction.reply({ content: '⚠️ Комната уже не существует.', ephemeral: true });
    return;
  }

  // "Забрать права" доступно не только владельцу — обрабатываем отдельно.
  if (action === 'claim') {
    const room = voiceData.rooms[roomId];
    if (!room) {
      await interaction.reply({ content: '⚠️ Эта комната больше не отслеживается.', ephemeral: true });
      return;
    }
    const clicker = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!clicker || clicker.voice.channelId !== roomId) {
      await interaction.reply({ content: '⚠️ Чтобы забрать права, нужно находиться в этой комнате.', ephemeral: true });
      return;
    }
    const ownerMember = await guild.members.fetch(room.ownerId).catch(() => null);
    if (ownerMember && ownerMember.voice.channelId === roomId) {
      await interaction.reply({ content: 'ℹ️ Владелец сейчас в комнате, забрать права нельзя.', ephemeral: true });
      return;
    }
    room.ownerId = interaction.user.id;
    saveVoiceData(voiceData);
    await applyRoomPermissions(guild, channel, room);
    await refreshVoicePanel(guild, roomId);
    await interaction.reply({ content: '✅ Ты стал(а) владельцем комнаты.', ephemeral: true });
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
      ephemeral: true,
    });
    return;
  }

  if (action === 'waitingroom') {
    if (!room.locked) {
      await interaction.reply({
        content: '⚠️ Сначала включи «Приватность», зал ожидания работает только для закрытой комнаты.',
        ephemeral: true,
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
        ephemeral: true,
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
      await interaction.reply({ content: '⏳ Зал ожидания выключен.', ephemeral: true });
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
      ephemeral: true,
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
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'region') {
    const select = new StringSelectMenuBuilder()
      .setCustomId(cid('voice', 'selectregion', roomId))
      .setPlaceholder('Выберите регион голосового сервера')
      .addOptions(VOICE_REGIONS.map((r) => ({ label: r.label, value: r.value })));
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
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
    await interaction.reply({ content: '🗑️ Комната будет удалена.', ephemeral: true });
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
    await interaction.reply({ content: '⛔ Управлять комнатой может только её владелец.', ephemeral: true });
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
    await interaction.reply({ content: '⚠️ Комната уже не существует.', ephemeral: true });
    return;
  }

  if (action === 'renamemodal') {
    const name = interaction.fields.getTextInputValue('name').trim();
    try {
      await channel.setName(name);
      await refreshVoicePanel(guild, roomId);
      await interaction.reply({ content: `✅ Комната переименована в «${name}».`, ephemeral: true });
    } catch (e) {
      await interaction.reply({ content: `⚠️ Не удалось переименовать: ${e.message || e}`, ephemeral: true });
    }
    return;
  }

  if (action === 'limitmodal') {
    const raw = interaction.fields.getTextInputValue('limit').trim();
    if (!/^\d+$/.test(raw) || parseInt(raw, 10) > 99) {
      await interaction.reply({ content: '⚠️ Введите число от 0 до 99 (0 = без лимита).', ephemeral: true });
      return;
    }
    try {
      await channel.setUserLimit(parseInt(raw, 10));
      await interaction.reply({
        content: raw === '0' ? '✅ Лимит участников снят.' : `✅ Лимит участников: ${raw}.`,
        ephemeral: true,
      });
    } catch (e) {
      await interaction.reply({ content: `⚠️ Не удалось задать лимит: ${e.message || e}`, ephemeral: true });
    }
    return;
  }
}

// ---------- События ----------
client.once('ready', async () => {
  console.log(`Вошёл как ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Ошибка регистрации команд:', e);
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
              .setEmoji('✅')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(cid('voice', 'waitdecline', roomId, newState.member.id))
              .setLabel('Отклонить')
              .setEmoji('❌')
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

client.on('interactionCreate', async (interaction) => {
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

// Обновленная функция отправки оповещения, использующая новую chunkMentions
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
      ephemeral: true,
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
  const sent = await interaction.editReply({
    embeds: [embed],
    components: [row, buildAdminRow(list)],
    fetchReply: true,
  });
  list.messageId = sent.id;
  saveLists(lists);

  try {
    await guild.members.fetch({ force: true });
    const membersWithRole = role.members
      .map((m) => m.id)
      .filter((id) => id !== client.user.id);

    if (!membersWithRole.length) {
      await interaction.followUp({
        content: `ℹ️ У роли **${role.name}** сейчас нет участников — оповещение не отправлено.`,
        ephemeral: true,
      });
      return;
    }

    const chunks = chunkMentions(
      membersWithRole,
      `📡 Оповещение по роли **${role.name}** — набор «${title}»:\n`
    );
    const channel = interaction.channel;

    // Модифицированный цикл с поддержкой объектов-чанков
    for (const chunk of chunks) {
      if (!chunk.content) continue;

      const msg = await channel.send({
        content: chunk.content,
        // Передаем только те ID, которые физически находятся в этом сообщении
        allowedMentions: { users: chunk.users },
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
    await interaction.reply({ content: '⛔ Нужны права «Управление сервером».', ephemeral: true });
    return;
  }

  const trigger = interaction.options.getChannel('триггер');
  const category = interaction.options.getChannel('категория');

  if (trigger.type !== ChannelType.GuildVoice) {
    await interaction.reply({ content: '⚠️ Триггер должен быть голосовым каналом.', ephemeral: true });
    return;
  }
  if (category.type !== ChannelType.GuildCategory) {
    await interaction.reply({ content: '⚠️ Категория должна быть именно категорией.', ephemeral: true });
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
    ephemeral: true,
  });
}

async function handleButton(interaction) {
  const [prefix, action, listId] = parseCid(interaction.customId);
  if (prefix !== 'wine') return;
  const list = lists.get(listId);
  if (!list) {
    await interaction.reply({ content: '⚠️ Этот набор больше не существует.', ephemeral: true });
    return;
  }
  const guild = interaction.guild;
  const uid = interaction.user.id;

  if (action === 'join') {
    if (!list.isOpen) {
      await interaction.reply({ content: '🔒 Сбор сейчас закрыт, присоединиться нельзя.', ephemeral: true });
      return;
    }
    if (list.participants.includes(uid)) {
      await interaction.reply({ content: 'Вы уже в основном составе.', ephemeral: true });
      return;
    }
    if (list.reserve.includes(uid)) {
      await interaction.reply({ content: 'Вы уже в резерве.', ephemeral: true });
      return;
    }
    if (isFull(list)) {
      list.reserve.push(uid);
      saveLists(lists);
      await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list), buildAdminRow(list)] });
      return;
    }
    list.participants.push(uid);
    saveLists(lists);
    await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list), buildAdminRow(list)] });
    await syncThreadMembers(guild, list, uid, null);
    return;
  }

  if (action === 'leave') {
    if (list.participants.includes(uid)) {
      list.participants = list.participants.filter((id) => id !== uid);
      const posChanged = freeUserPosition(list, uid);
      saveLists(lists);
      await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list), buildAdminRow(list)] });
      await syncThreadMembers(guild, list, null, uid);
      if (posChanged) await updatePositionsMessage(guild, list);
      return;
    }
    if (list.reserve.includes(uid)) {
      list.reserve = list.reserve.filter((id) => id !== uid);
      saveLists(lists);
      await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list), buildAdminRow(list)] });
      return;
    }
    await interaction.reply({ content: 'Вы не записаны ни в основной состав, ни в резерв.', ephemeral: true });
    return;
  }

  if (action === 'toggleopen') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    list.isOpen = !list.isOpen;
    saveLists(lists);
    await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list), buildAdminRow(list)] });
    return;
  }

  if (action === 'manage') {
    if (!isManager(list, uid)) {
      await interaction.reply({
        content: '⛔ Только создатель или администратор набора может это делать.',
        ephemeral: true,
      });
      return;
    }
    const row1Buttons = [
      new ButtonBuilder()
        .setCustomId(cid('wine', 'addperson', listId))
        .setLabel('Добавить участников')
        .setEmoji('🆕')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(cid('wine', 'removeperson', listId))
        .setLabel('Удалить участников')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger),
    ];
    await interaction.reply({
      content:
        '🛠️ Панель управления набором:\n' +
        '_«Добавить участников» переносит и людей из резерва — их оттуда уберёт автоматически._\n' +
        '_Назначить администратора можно кнопкой «Добавить администратора» под основным сообщением набора._',
      components: [new ActionRowBuilder().addComponents(row1Buttons)],
      ephemeral: true,
    });
    return;
  }

  if (action === 'addadmin') {
    if (list.creatorId !== uid) {
      await interaction.reply({ content: '⛔ Только создатель набора может это делать.', ephemeral: true });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectaddadmin', listId))
      .setPlaceholder('Выберите пользователя для назначения администратором')
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'addperson') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectaddperson', listId))
      .setPlaceholder('Выберите одного или нескольких пользователей')
      .setMinValues(1)
      .setMaxValues(25);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'removeperson') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectremoveperson', listId))
      .setPlaceholder('Выберите одного или нескольких пользователей')
      .setMinValues(1)
      .setMaxValues(25);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'thread') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    if (list.threadId) {
      await interaction.reply({ content: `ℹ️ Ветка уже создана: <#${list.threadId}>`, ephemeral: true });
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
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', ephemeral: true });
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
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', ephemeral: true });
      return;
    }
    const idx = list.positions.findIndex((p) => p === uid);
    if (idx === -1) {
      await interaction.reply({ content: 'Вы не занимаете ни одной позиции.', ephemeral: true });
      return;
    }
    list.positions[idx] = null;
    saveLists(lists);
    await interaction.deferUpdate();
    await updatePositionsMessage(guild, list);
    await interaction.followUp({ content: `✅ Вы покинули позицию №${idx + 1}.`, ephemeral: true });
    return;
  }

  if (action === 'posmanage') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', ephemeral: true });
      return;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(cid('wine', 'assignposition', listId))
        .setLabel('Назначить участника')
        .setEmoji('🆕')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(cid('wine', 'removeposition', listId))
        .setLabel('Снять с позиции')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );
    await interaction.reply({ content: '🎖️ Управление позициями:', components: [row], ephemeral: true });
    return;
  }

  if (action === 'assignposition') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(cid('wine', 'selectassignpos', listId))
      .setPlaceholder('Выберите пользователя для назначения на позицию')
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'removeposition') {
    if (!isManager(list, uid)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
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
    await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
    return;
  }

  const guild = interaction.guild;

  if (action === 'selectaddadmin') {
    if (list.creatorId !== interaction.user.id) {
      await interaction.reply({ content: '⛔ Только создатель набора может это делать.', ephemeral: true });
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
    await updateListMessage(guild, list);
    for (const targetId of added) {
      await syncThreadMembers(guild, list, targetId, null);
    }
    const parts = [];
    if (added.length) parts.push(`✅ Добавлены в состав: ${added.map((id) => `<@${id}>`).join(', ')}`);
    if (already.length) parts.push(`ℹ️ Уже были в составе: ${already.map((id) => `<@${id}>`).join(', ')}`);
    await interaction.update({ content: parts.join('\n') || 'Ничего не изменилось.', components: [] });
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
    await updateListMessage(guild, list);
    for (const targetId of removed) {
      await syncThreadMembers(guild, list, null, targetId);
    }
    if (anyPosChanged) await updatePositionsMessage(guild, list);
    const parts = [];
    if (removed.length) parts.push(`🗑️ Удалены: ${removed.map((id) => `<@${id}>`).join(', ')}`);
    if (notFound.length) parts.push(`ℹ️ Не были в списке: ${notFound.map((id) => `<@${id}>`).join(', ')}`);
    await interaction.update({ content: parts.join('\n') || 'Ничего не изменилось.', components: [] });
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
    await interaction.reply({ content: '⚠️ Набор не найден.', ephemeral: true });
    return;
  }

  if (action === 'threadmodal') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }

    const threadName = interaction.fields.getTextInputValue('threadname');
    const positionsRaw = interaction.fields.getTextInputValue('positions').trim();

    let positionsCount = null;
    if (positionsRaw !== '-' && positionsRaw !== '') {
      if (!/^\d+$/.test(positionsRaw) || parseInt(positionsRaw, 10) <= 0) {
        await interaction.reply({
          content: '⚠️ Количество позиций должно быть целым числом больше 0, либо «-» если список позиций не нужен.',
          ephemeral: true,
        });
        return;
      }
      positionsCount = parseInt(positionsRaw, 10);
    }

    await interaction.deferReply({ ephemeral: true });

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

      for (const uid of list.participants) {
        await thread.members.add(uid).catch((e) => {
          console.error(`Не удалось добавить ${uid} в ветку:`, e);
        });
      }

      if (positionsCount) {
        list.positionsCount = positionsCount;
        list.positions = new Array(positionsCount).fill(null);
        saveLists(lists);
        const posMsg = await thread.send({
          embeds: [buildPositionsEmbed(list)],
          components: [buildPositionsRow(list)],
        });
        list.positionsMessageId = posMsg.id;
      }

      saveLists(lists);
      await updateListMessage(guild, list);

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
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', ephemeral: true });
      return;
    }
    const raw = interaction.fields.getTextInputValue('position').trim();
    const pos = parseInt(raw, 10);

    if (!/^\d+$/.test(raw) || pos < 1 || pos > list.positionsCount) {
      await interaction.reply({
        content: `⚠️ Номер позиции должен быть от 1 до ${list.positionsCount}.`,
        ephemeral: true,
      });
      return;
    }

    const occupant = list.positions[pos - 1];
    if (occupant && occupant !== interaction.user.id) {
      await interaction.reply({ content: `⚠️ Позиция №${pos} уже занята <@${occupant}>.`, ephemeral: true });
      return;
    }
    if (occupant === interaction.user.id) {
      await interaction.reply({ content: `Вы уже занимаете позицию №${pos}.`, ephemeral: true });
      return;
    }

    list.positions = list.positions.map((p) => (p === interaction.user.id ? null : p));
    list.positions[pos - 1] = interaction.user.id;
    saveLists(lists);

    await interaction.deferReply({ ephemeral: true });
    await updatePositionsMessage(interaction.guild, list);
    await interaction.editReply({ content: `✅ Вы заняли позицию №${pos}.` });
    return;
  }

  if (action === 'assignposmodal') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', ephemeral: true });
      return;
    }
    const targetId = extra;
    const raw = interaction.fields.getTextInputValue('position').trim();
    const pos = parseInt(raw, 10);

    if (!/^\d+$/.test(raw) || pos < 1 || pos > list.positionsCount) {
      await interaction.reply({
        content: `⚠️ Номер позиции должен быть от 1 до ${list.positionsCount}.`,
        ephemeral: true,
      });
      return;
    }

    list.positions = list.positions.map((p) => (p === targetId ? null : p));
    list.positions[pos - 1] = targetId;
    saveLists(lists);

    await interaction.deferReply({ ephemeral: true });
    await updatePositionsMessage(interaction.guild, list);
    await interaction.editReply({ content: `✅ <@${targetId}> назначен на позицию №${pos}.` });
    return;
  }

  if (action === 'removeposmodal') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: '⛔ Нет доступа.', ephemeral: true });
      return;
    }
    if (!list.positionsCount) {
      await interaction.reply({ content: '⚠️ В этом наборе нет списка позиций.', ephemeral: true });
      return;
    }
    const raw = interaction.fields.getTextInputValue('position').trim();
    const pos = parseInt(raw, 10);

    if (!/^\d+$/.test(raw) || pos < 1 || pos > list.positionsCount) {
      await interaction.reply({
        content: `⚠️ Номер позиции должен быть от 1 до ${list.positionsCount}.`,
        ephemeral: true,
      });
      return;
    }

    if (!list.positions[pos - 1]) {
      await interaction.reply({ content: `Позиция №${pos} уже свободна.`, ephemeral: true });
      return;
    }

    list.positions[pos - 1] = null;
    saveLists(lists);

    await interaction.deferReply({ ephemeral: true });
    await updatePositionsMessage(interaction.guild, list);
    await interaction.editReply({ content: `✅ Позиция №${pos} освобождена.` });
    return;
  }
}

client.login(TOKEN);
