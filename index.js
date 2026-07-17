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
const GUILD_ID = process.env.GUILD_ID; // необязательно, для быстрой регистрации команд на одном сервере

if (!TOKEN || !CLIENT_ID) {
  console.error('Не заданы BOT_TOKEN и/или CLIENT_ID в переменных окружения (.env).');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // нужен привилегированный интент "Server Members Intent"
  ],
});

const lists = loadLists();

const MODES = ['ВЗП', 'КАПТ', 'ПОСТАВКА', 'КОНТЕНТ'];

// ---------- Описание слэш-команды ----------
const wineCommand = new SlashCommandBuilder()
  .setName('wine')
  .setDescription('Создать набор участников')
  .addStringOption((opt) =>
    opt
      .setName('режим')
      .setDescription('Режим набора')
      .setRequired(true)
      .addChoices(...MODES.map((m) => ({ name: m, value: m })))
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

function buildEmbed(list) {
  const qtyText =
    list.quantity === 'Неограничено'
      ? `${list.participants.length} / ∞`
      : `${list.participants.length} / ${list.quantity}`;

  const fields = [
    { name: 'Режим', value: list.mode, inline: true },
    { name: 'Количество', value: qtyText, inline: true },
    { name: 'Время', value: list.time, inline: true },
    { name: 'Организатор', value: `<@${list.creatorId}>`, inline: true },
  ];

  const lines = list.participants.length
    ? list.participants.map((id, i) => `${i + 1}. <@${id}>`)
    : ['_пока никого_'];

  let chunk = '';
  const partChunks = [];
  for (const line of lines) {
    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > 1000) {
      partChunks.push(chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) partChunks.push(chunk);

  partChunks.forEach((val, i) => {
    fields.push({
      name: i === 0 ? `Участники (${list.participants.length})` : '\u200b',
      value: val,
    });
  });

  return new EmbedBuilder()
    .setTitle(`Набор: ${list.mode}`)
    .setColor(0x8b0000)
    .addFields(fields)
    .setFooter({ text: list.threadId ? 'Ветка создана' : `ID набора: ${list.id}` })
    .setTimestamp();
}

function buildMainRow(list) {
  const joinBtn = new ButtonBuilder()
    .setCustomId(`wine_join_${list.id}`)
    .setLabel('Присоединиться')
    .setStyle(ButtonStyle.Success)
    .setDisabled(isFull(list));

  const leaveBtn = new ButtonBuilder()
    .setCustomId(`wine_leave_${list.id}`)
    .setLabel('Покинуть')
    .setStyle(ButtonStyle.Danger);

  const manageBtn = new ButtonBuilder()
    .setCustomId(`wine_manage_${list.id}`)
    .setLabel('Управление')
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(joinBtn, leaveBtn, manageBtn);
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

function splitCustomId(customId) {
  const parts = customId.split('_');
  return [parts[0], parts[1], parts.slice(2).join('_')];
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
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'Произошла ошибка. Попробуйте ещё раз.', ephemeral: true })
        .catch(() => {});
    }
  }
});

async function handleWineCommand(interaction) {
  const mode = interaction.options.getString('режим');
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
      content: 'Количество должно быть числом или словом «Неограничено».',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const guild = interaction.guild;
  await guild.members.fetch();
  const membersWithRole = role.members.map((m) => m.id).filter((id) => id !== client.user.id);

  const listId = genId();
  const list = {
    id: listId,
    guildId: guild.id,
    channelId: interaction.channelId,
    messageId: null,
    creatorId: interaction.user.id,
    mode,
    quantity,
    time,
    roleId: role.id,
    participants: [],
    admins: [],
    threadId: null,
  };
  lists.set(listId, list);

  const embed = buildEmbed(list);
  const row = buildMainRow(list);
  const sent = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });
  list.messageId = sent.id;
  saveLists(lists);

  if (membersWithRole.length) {
    const chunks = chunkMentions(
      membersWithRole,
      `Оповещение по роли **${role.name}** — набор «${mode}»:\n`
    );
    const channel = interaction.channel;
    for (const chunk of chunks) {
      const msg = await channel.send({
        content: chunk,
        allowedMentions: { users: membersWithRole },
      });
      setTimeout(() => msg.delete().catch(() => {}), 5000);
    }
  }
}

async function handleButton(interaction) {
  const [prefix, action, listId] = splitCustomId(interaction.customId);
  if (prefix !== 'wine') return;
  const list = lists.get(listId);
  if (!list) {
    await interaction.reply({ content: 'Этот набор больше не существует.', ephemeral: true });
    return;
  }
  const guild = interaction.guild;

  if (action === 'join') {
    if (list.participants.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Вы уже в списке.', ephemeral: true });
      return;
    }
    if (isFull(list)) {
      await interaction.reply({ content: 'Набор уже заполнен.', ephemeral: true });
      return;
    }
    list.participants.push(interaction.user.id);
    saveLists(lists);
    await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
    await syncThreadMembers(guild, list, interaction.user.id, null);
    return;
  }

  if (action === 'leave') {
    if (!list.participants.includes(interaction.user.id)) {
      await interaction.reply({ content: 'Вас нет в списке.', ephemeral: true });
      return;
    }
    list.participants = list.participants.filter((id) => id !== interaction.user.id);
    saveLists(lists);
    await interaction.update({ embeds: [buildEmbed(list)], components: [buildMainRow(list)] });
    await syncThreadMembers(guild, list, null, interaction.user.id);
    return;
  }

  if (action === 'manage') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({
        content: 'Только создатель или администратор набора может это делать.',
        ephemeral: true,
      });
      return;
    }
    const isCreator = list.creatorId === interaction.user.id;
    const row1Buttons = [];
    if (isCreator) {
      row1Buttons.push(
        new ButtonBuilder()
          .setCustomId(`wine_addadmin_${listId}`)
          .setLabel('Добавить администратора')
          .setStyle(ButtonStyle.Primary)
      );
    }
    row1Buttons.push(
      new ButtonBuilder()
        .setCustomId(`wine_addperson_${listId}`)
        .setLabel('Добавить участника')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`wine_removeperson_${listId}`)
        .setLabel('Удалить участника')
        .setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`wine_thread_${listId}`)
        .setLabel('Создать ветку')
        .setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({
      content: 'Панель управления набором:',
      components: [new ActionRowBuilder().addComponents(row1Buttons), row2],
      ephemeral: true,
    });
    return;
  }

  if (action === 'addadmin') {
    if (list.creatorId !== interaction.user.id) {
      await interaction.reply({ content: 'Только создатель набора может это делать.', ephemeral: true });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(`wine_selectaddadmin_${listId}`)
      .setPlaceholder('Выберите пользователя для назначения администратором')
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'addperson') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: 'Нет доступа.', ephemeral: true });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(`wine_selectaddperson_${listId}`)
      .setPlaceholder('Выберите пользователя для добавления в список')
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'removeperson') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: 'Нет доступа.', ephemeral: true });
      return;
    }
    const select = new UserSelectMenuBuilder()
      .setCustomId(`wine_selectremoveperson_${listId}`)
      .setPlaceholder('Выберите пользователя для удаления из списка')
      .setMinValues(1)
      .setMaxValues(1);
    await interaction.reply({ components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
    return;
  }

  if (action === 'thread') {
    if (!isManager(list, interaction.user.id)) {
      await interaction.reply({ content: 'Нет доступа.', ephemeral: true });
      return;
    }
    const modal = new ModalBuilder().setCustomId(`wine_threadmodal_${listId}`).setTitle('Создать ветку');
    const input = new TextInputBuilder()
      .setCustomId('threadname')
      .setLabel('Название ветки')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(90);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }
}

async function handleUserSelect(interaction) {
  const [prefix, action, listId] = splitCustomId(interaction.customId);
  if (prefix !== 'wine') return;
  const list = lists.get(listId);
  if (!list) {
    await interaction.update({ content: 'Набор не найден.', components: [] });
    return;
  }
  if (!isManager(list, interaction.user.id)) {
    await interaction.reply({ content: 'Нет доступа.', ephemeral: true });
    return;
  }

  const targetId = interaction.values[0];
  const guild = interaction.guild;

  if (action === 'selectaddadmin') {
    if (list.creatorId !== interaction.user.id) {
      await interaction.reply({ content: 'Только создатель набора может это делать.', ephemeral: true });
      return;
    }
    if (!list.admins.includes(targetId)) list.admins.push(targetId);
    saveLists(lists);
    await interaction.update({ content: `<@${targetId}> назначен администратором набора.`, components: [] });
    return;
  }

  if (action === 'selectaddperson') {
    if (list.participants.includes(targetId)) {
      await interaction.update({ content: 'Этот пользователь уже в списке.', components: [] });
      return;
    }
    list.participants.push(targetId);
    saveLists(lists);
    await updateListMessage(guild, list);
    await syncThreadMembers(guild, list, targetId, null);
    await interaction.update({ content: `<@${targetId}> добавлен в список.`, components: [] });
    return;
  }

  if (action === 'selectremoveperson') {
    if (!list.participants.includes(targetId)) {
      await interaction.update({ content: 'Этого пользователя нет в списке.', components: [] });
      return;
    }
    list.participants = list.participants.filter((id) => id !== targetId);
    saveLists(lists);
    await updateListMessage(guild, list);
    await syncThreadMembers(guild, list, null, targetId);
    await interaction.update({ content: `<@${targetId}> удалён из списка.`, components: [] });
    return;
  }
}

async function handleModalSubmit(interaction) {
  const [prefix, action, listId] = splitCustomId(interaction.customId);
  if (prefix !== 'wine' || action !== 'threadmodal') return;
  const list = lists.get(listId);
  if (!list) {
    await interaction.reply({ content: 'Набор не найден.', ephemeral: true });
    return;
  }
  if (!isManager(list, interaction.user.id)) {
    await interaction.reply({ content: 'Нет доступа.', ephemeral: true });
    return;
  }

  const threadName = interaction.fields.getTextInputValue('threadname');
  const guild = interaction.guild;
  const channel = await guild.channels.fetch(list.channelId);

  await interaction.deferReply({ ephemeral: true });

  const thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 1440,
    reason: `Ветка для набора ${list.mode} (${list.id})`,
  });

  list.threadId = thread.id;
  saveLists(lists);

  for (const uid of list.participants) {
    await thread.members.add(uid).catch(() => {});
  }
  await updateListMessage(guild, list);

  await interaction.editReply({ content: `Ветка «${threadName}» создана: ${thread.toString()}` });
}

client.login(TOKEN);
