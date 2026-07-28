require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');

const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;

if (!apiId || !apiHash) {
  console.error('Не заданы API_ID и/или API_HASH в .env (их берут на my.telegram.org/apps).');
  process.exit(1);
}

(async () => {
  console.log('Запуск входа в Telegram...');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Номер телефона (с кодом страны, например +79991234567): '),
    password: async () => await input.text('Пароль двухфакторной аутентификации (если не включена — просто Enter): '),
    phoneCode: async () => await input.text('Код из Telegram: '),
    onError: (err) => console.error(err),
  });

  console.log('\n✅ Успешный вход!\n');
  console.log('Сохрани эту строку как переменную окружения TELEGRAM_SESSION (она хранит доступ к аккаунту — никому не показывай):\n');
  console.log(client.session.save());
  console.log('');

  await client.disconnect();
  process.exit(0);
})();
