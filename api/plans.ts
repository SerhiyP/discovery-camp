import type { VercelRequest, VercelResponse } from "@vercel/node";

// Static Ukrainian-language summary of the two approved design specs
// (docs/superpowers/specs/2026-08-08-communication-help-desk-design.md and
// 2026-08-07-web-admin-panel-design.md), written for non-technical management
// to review and confirm. Served at /plans via a vercel.json rewrite.
export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(PAGE);
}

const PAGE = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Бот Discovery Camp — два кроки розвитку</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #FAFBF8;
    --card: #FFFFFF;
    --ink: #1F2A24;
    --muted: #5C6B61;
    --line: #E3E8E0;
    --pine: #2E6B4F;
    --pine-soft: #EAF3EE;
    --chip-ink: #24503C;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #151A17;
      --card: #1D2420;
      --ink: #E8EDE7;
      --muted: #9AA89E;
      --line: #2C352F;
      --pine: #6FBF95;
      --pine-soft: #21332A;
      --chip-ink: #A9D8BF;
    }
  }

  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    line-height: 1.6;
    margin: 0;
    padding: 0 20px 80px;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 680px; margin: 0 auto; }

  .eyebrow {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--pine);
    margin: 48px 0 10px;
  }
  h1 {
    font-size: clamp(28px, 6vw, 38px);
    line-height: 1.15;
    font-weight: 750;
    letter-spacing: -0.015em;
    margin: 0 0 14px;
    text-wrap: balance;
  }
  .lede { font-size: 17px; color: var(--muted); margin: 0 0 18px; max-width: 60ch; }

  .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .meta span {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--chip-ink);
    background: var(--pine-soft);
    border-radius: 999px;
    padding: 4px 12px;
  }

  section {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 28px clamp(20px, 4vw, 32px) 30px;
    margin-top: 28px;
  }
  .step-label {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--pine);
    margin: 0 0 8px;
  }
  h2 {
    font-size: 23px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.25;
    margin: 0 0 4px;
    text-wrap: balance;
  }
  .when { font-size: 14px; color: var(--muted); margin: 0 0 18px; }
  h3 {
    font-size: 16px;
    font-weight: 700;
    margin: 26px 0 8px;
  }
  p { margin: 0 0 12px; }
  ul { margin: 0 0 12px; padding-left: 22px; }
  li { margin-bottom: 6px; }
  li::marker { color: var(--pine); }
  .quiet { color: var(--muted); }
  strong { font-weight: 650; }

  .flow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 14px 0 6px;
  }
  .flow .node {
    background: var(--pine-soft);
    color: var(--chip-ink);
    font-size: 14px;
    font-weight: 600;
    border-radius: 10px;
    padding: 7px 13px;
    white-space: nowrap;
  }
  .flow .arrow { color: var(--muted); font-size: 14px; }

  .personas { display: grid; gap: 12px; margin-top: 14px; }
  .persona {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
  }
  .persona b { display: block; font-size: 14.5px; margin-bottom: 4px; }
  .persona p { font-size: 14.5px; color: var(--muted); margin: 0; }

  footer {
    max-width: 680px;
    margin: 36px auto 0;
    font-size: 13.5px;
    color: var(--muted);
  }
</style>
</head>
<body>
<main>
  <p class="eyebrow">Discovery Camp · Telegram-бот табору</p>
  <h1>Два кроки розвитку бота</h1>
  <p class="lede">Цього року бот умів надсилати повідомлення лише «згори вниз» — від
  організаторів до дітей. До наступного табору плануємо два кроки, описані нижче.
  Сторінка написана без технічних деталей.</p>
  <div class="meta">
    <span>Серпень 2026</span>
    <span>Плани на наступний табір</span>
  </div>

  <section>
    <p class="step-label">Крок 1</p>
    <h2>«🙋 Допомога» — зворотний зв'язок у боті</h2>

    <h3>Яку проблему вирішуємо</h3>
    <p>Дитина ніяк не може звернутися до дорослих через бот. Якщо лідер створив групу
    команди — добре; якщо ні, або дитину забули додати — вона лишається без зв'язку.
    До лікаря чи організаторів написати взагалі нема куди.</p>

    <h3>Як це працюватиме</h3>
    <div class="flow">
      <span class="node">🙋 Допомога</span>
      <span class="arrow">→</span>
      <span class="node">Кому? Лідеру · Лікарю · Організаторам</span>
      <span class="arrow">→</span>
      <span class="node">Дитина пише питання</span>
      <span class="arrow">→</span>
      <span class="node">Отримує відповідь</span>
    </div>
    <p class="quiet">У кожної дитини в боті з'явиться кнопка «Допомога». Вона обирає,
    до кого звертається, і пише повідомлення — бот сам доставить його потрібній людині.</p>

    <div class="personas">
      <div class="persona">
        <b>Для дитини</b>
        <p>Натиснула кнопку, написала «болить живіт» — і за кілька хвилин отримала
        відповідь. Не треба знати жодних номерів чи шукати дорослих по табору.</p>
      </div>
      <div class="persona">
        <b>Для лідера</b>
        <p>Отримує питання разом з ім'ям, віком і кімнатою дитини та посиланням на її
        профіль — відповідає особисто, як звичайним повідомленням у Telegram.</p>
      </div>
      <div class="persona">
        <b>Для лікаря та організаторів</b>
        <p>Відповідають прямо через бот — їхні особисті акаунти дітям не видно. Дві
        кнопки: «Відповісти» та «Опрацьовано». Жодне звернення не губиться: організатори
        завжди бачать список ще не опрацьованих.</p>
      </div>
    </div>

    <h3>Групи команд</h3>
    <p>Звичайні Telegram-групи команд залишаються — вони найкращі для спілкування дітей
    між собою. Бот лише допоможе лідерам: підкаже створити групу і розіслати запрошення
    всій команді однією кнопкою, щоб ніхто не залишився поза групою. Кнопка «Допомога»
    працює як запасний канал для тих, хто до групи ще не потрапив.</p>
  </section>

  <section>
    <p class="step-label">Крок 2</p>
    <h2>Веб-сторінка адміністратора</h2>

    <h3>Яку проблему вирішуємо</h3>
    <p>Зараз усе адміністрування — це Google-таблиці та команди в боті. Це працює, але
    вимагає обережності: легко зачепити не ту клітинку, а статистику треба щоразу
    запитувати командою.</p>

    <h3>Як це працюватиме</h3>
    <p>Окрема веб-сторінка, куди адміністратори входять через свій Telegram — без нових
    паролів. На ній:</p>
    <ul>
      <li><strong>Статистика наживо</strong> — скільки заїхало, хто без медогляду чи
      оплати, реєстрації на майстер-класи.</li>
      <li><strong>Керування людьми</strong> — додати чи прибрати адміністратора, лідера,
      лікаря, відповідального за майстер-клас; виправити помилковий заїзд.</li>
      <li><strong>Розсилки</strong> — написати оголошення всім з попереднім переглядом
      перед відправкою.</li>
      <li><strong>Майстер-класи</strong> — розклад, теми та кількість місць редагуються
      на сторінці, а не в таблиці.</li>
    </ul>

    <h3>Що не змінюється</h3>
    <ul>
      <li>Реєстрація учасників — та сама Google-форма.</li>
      <li>Оплати — фінансист і далі відмічає їх у таблиці, як зараз.</li>
      <li>Бот для дітей і лідерів працює без змін.</li>
    </ul>
  </section>

  <footer>Технічні деталі обох рішень описані в проєктній документації репозиторію
  (docs/superpowers/specs). Ця сторінка — короткий виклад для погодження.</footer>
</main>
</body>
</html>`;