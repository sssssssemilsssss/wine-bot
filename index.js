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
} = require('discord.js');
const { loadLists, saveLists } = require('./storage');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('Не заданы BOT_TOKEN и/или CLIENT_ID в переменных окружения (.env).');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const lists = loadLists();

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

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = [wineCommand.toJSON()];
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

// ---------- События ----------
client.once('ready', async () => {
  console.log(`Вошёл как ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('Ошибка регистрации команд:', e);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'wine') {
      await handleWineCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isUserSelectMenu()) {
      await handleUserSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
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
  const sent = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });
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
    await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
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
    const isCreator = list.creatorId === uid;
    const row1Buttons = [];
    if (isCreator) {
      row1Buttons.push(
        new ButtonBuilder()
          .setCustomId(cid('wine', 'addadmin', listId))
          .setLabel('Добавить администратора')
          .setEmoji('🎖️')
          .setStyle(ButtonStyle.Primary)
      );
    }
    row1Buttons.push(
      new ButtonBuilder()
        .setCustomId(cid('wine', 'addperson', listId))
        .setLabel('Добавить участников')
        .setEmoji('🆕')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(cid('wine', 'removeperson', listId))
        .setLabel('Удалить участников')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger)
    );
    await interaction.reply({
      content:
        '🛠️ Панель управления набором:\n' +
        '_«Добавить участников» переносит и людей из резерва — их оттуда уберёт автоматически._',
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
