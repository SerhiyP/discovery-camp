# Discovery Camp — Telegram check-in bot

Чек-ін через QR-код → Telegram, відмітка в Google Sheets, відеопривітання від лідера команди, реєстрація на події та ранкові нагадування. Хоститься на Vercel (serverless + cron).

## Як це працює

1. На вході висить плакат із QR-кодом (`npm run qr`). Він відкриває бота: `t.me/<bot>?start=checkin`.
2. Відвідувач пише своє прізвище та ім'я → бот шукає його у вкладці з відповідями форми → показує кнопки зі збігами.
3. Після підтвердження бот записує Telegram ID і час чек-іну в таблицю та надсилає відео лідера команди.
4. Далі бот знає людину назавжди: `/events` (реєстрація на події дня), `/schedule`, `/myevents`, ранковий дайджест о 8:00 за Києвом.

## Налаштування

### 1. Бот

- Створіть бота через [@BotFather](https://t.me/BotFather) → отримайте `BOT_TOKEN`.
- Дізнайтесь свій Telegram ID (наприклад, через @userinfobot) → `ADMIN_IDS`.

### 2. Google Sheets

- У [Google Cloud Console](https://console.cloud.google.com) створіть проєкт → увімкніть **Google Sheets API** → створіть **Service Account** → згенеруйте JSON-ключ.
- З ключа візьміть `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL` і `private_key` → `GOOGLE_PRIVATE_KEY`.
- **Поділіться таблицею** з email сервісного акаунта (роль Editor).
- `SHEET_ID` — це частина URL таблиці між `/d/` і `/edit`.

У таблиці:

- **Вкладка з відповідями форми** (`RESPONSES_TAB`): додайте праворуч дві колонки з заголовками `Checked in` і `Telegram ID`. У `NAME_HEADER` вкажіть точний текст питання з ПІБ. Якщо є колонка з командою — вкажіть її заголовок у `TEAM_HEADER`.
- **Вкладка `Events`** з заголовками: `ID | Date | Time | Title | Capacity`
  - `Date` у форматі `2026-07-13`, `Capacity` = 0 — без обмежень. `ID` — будь-який унікальний (e1, e2…).
- **Вкладка `EventRegs`** з заголовками: `Event ID | Telegram ID | Name | Registered at | Cancelled at` (бот заповнює сам).
- **Вкладка `Videos`** (необов'язково): `Team | File ID` — відео для кожної команди.

### 3. Деплой на Vercel

```bash
npm install
npx vercel link
# додайте всі змінні з .env.example у Vercel → Settings → Environment Variables
npx vercel --prod
```

Потім зареєструйте webhook:

```bash
cp .env.example .env   # заповніть значення
npm run set-webhook
```

### 4. Відео лідерів

Надішліть (або перешліть) відео боту зі свого адмін-акаунта — бот відповість `file_id`. Вставте його у вкладку `Videos` навпроти назви команди (або в `DEFAULT_VIDEO_FILE_ID`, якщо відео одне для всіх).

### 5. QR-код для плаката

```bash
npm run qr   # створює checkin-qr.png (потрібен BOT_USERNAME у .env)
```

## Команди бота

| Команда | Опис |
|---|---|
| `/start` | чек-ін (пошук за ПІБ) |
| `/events` | події на сьогодні + кнопки реєстрації |
| `/schedule` | розклад на всі дні |
| `/myevents` | мої реєстрації |
| `/broadcast <текст>` | (адмін) розсилка всім, хто пройшов чек-ін |

## Нотатки

- Ранковий дайджест: cron у `vercel.json` (`0 5 * * *` UTC = 8:00 Києва влітку).
- Ліміт місць перевіряється при реєстрації; за одночасних кліків теоретично можливий незначний перебір — для табору це прийнятно.
- Telegram-розсилки йдуть послідовно; для кількох сотень учасників вкладається в 60 с cron-функції.
