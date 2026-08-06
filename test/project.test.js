const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../src/project-core.js');
const { handleCommand } = require('../native_host/store.js');

// Срез настоящей страницы заказа: состояние страницы отдаёт всё нужное одним
// объектом, вокруг него — соседние поля и вёрстка, как на бирже.
function buildProjectPage(overrides = {}) {
  const wantData = {
    id: 3230953,
    status: 'active',
    altStatusHint: { color: 'blue', title: 'Сбор предложений' },
    wantUserGetProfileUrl: 'https://kwork.ru/user/nurzhigit963',
    possiblePriceLimit: 4500,
    isHigherPrice: true,
    category_id: '38',
    description: 'Нужно усилить защиту сервера.\r\nПодключить Cloudflare и настроить WAF.',
    files: [
      {
        FID: 397123597,
        fname: 'Техническое_задание.docx',
        size: 37853,
        url: 'https://kwork.ru/files/uploaded/b8/5e/2f/6ab9c9c5c5/%D0%A2%D0%97.docx',
      },
    ],
    kwork_count: 5,
    name: 'Усиление защиты и оптимизация сервера',
    max_days: '10',
    priceLimit: '1500.00',
    user: {
      USERID: 21646176,
      username: 'nurzhigit963',
      data: { wants_count: '2', wants_hired_percent: '100' },
    },
    date_create: '2026-08-06 08:44:29',
    date_expire: '2026-08-07 08:45:06',
    views_dirty: '198',
    timeLeft: '22 ч. 13 мин.',
    ...overrides,
  };

  return `<!DOCTYPE html><html><body><div class="want-card"></div><script>window.stateData = {"maxPortfolioTitle":40,"wantData":${JSON.stringify(wantData)},"designVersion":"2"};</script></body></html>`;
}

function createProjectsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kph-projects-'));
}

test('страница заказа разбирается в данные для отклика', () => {
  const project = core.extractProject(buildProjectPage(), { url: 'https://kwork.ru/projects/3230953/view' });

  assert.equal(project.id, '3230953');
  assert.equal(project.title, 'Усиление защиты и оптимизация сервера');
  assert.match(project.description, /Подключить Cloudflare/);
  assert.equal(project.url, 'https://kwork.ru/projects/3230953/view');
  assert.equal(project.budget.desired, 1500);
  assert.equal(project.budget.maximum, 4500);
  assert.equal(project.client.username, 'nurzhigit963');
  assert.equal(project.client.profileUrl, 'https://kwork.ru/user/nurzhigit963');
  assert.equal(project.deadlineDays, 10);
  assert.equal(project.offers, 5);
  assert.equal(project.files.length, 1);
  assert.equal(project.files[0].file, 'Техническое_задание.docx');
  assert.equal(project.files[0].size, 37853);
});

test('допустимый бюджет не выдумывается, когда заказчик его не назвал', () => {
  const project = core.extractProject(buildProjectPage({ isHigherPrice: false }));

  assert.equal(project.budget.desired, 1500);
  assert.equal(project.budget.maximum, null);
});

test('страница без данных заказа не выдаёт пустую заготовку', () => {
  assert.equal(core.extractProject('<html><body>вход на биржу</body></html>'), null);
  assert.equal(core.extractProject('{"wantData":{сломано}'), null);
});

test('соседние поля состояния страницы не обрывают разбор заказа', () => {
  const page = buildProjectPage({ description: 'Строка с "кавычками" и скобкой }' });
  const project = core.extractProject(page);

  assert.match(project.description, /кавычками/);
  assert.equal(project.offers, 5);
});

test('имя папки заказа начинается с его номера', () => {
  const project = core.extractProject(buildProjectPage());

  assert.equal(core.buildProjectSlug(project), '3230953-усиление-защиты-и-оптимизация-сервера');
  assert.equal(core.buildProjectSlug({ id: '42', title: '' }), '42');
  assert.equal(core.buildProjectSlug({ id: '../secrets', title: 'подмена' }), null);
});

test('одинаковые имена файлов заказа разводятся номером', () => {
  const files = core.normalizeProjectFiles([
    { fname: 'бриф.pdf', url: 'https://kwork.ru/files/1/бриф.pdf' },
    { fname: 'бриф.pdf', url: 'https://kwork.ru/files/2/бриф.pdf' },
    { fname: 'без адреса.pdf' },
  ]);

  assert.deepEqual(files.map((item) => item.file), ['бриф.pdf', 'бриф (2).pdf']);
});

test('markdown заказа содержит всё, что нужно для отклика', () => {
  const project = core.extractProject(buildProjectPage(), { extractedAt: '2026-08-06T09:00:00.000Z' });
  const markdown = core.renderProjectMarkdown(project);

  assert.match(markdown, /^# Усиление защиты и оптимизация сервера/);
  assert.match(markdown, /- Ссылка на заказ: https:\/\/kwork\.ru\/projects\/3230953\/view/);
  assert.match(markdown, /- Заказчик: nurzhigit963 — https:\/\/kwork\.ru\/user\/nurzhigit963/);
  assert.match(markdown, /- Желаемый бюджет: 1 500 ₽/);
  assert.match(markdown, /- Допустимый бюджет: 4 500 ₽/);
  assert.match(markdown, /- Срок: до 10 дн\./);
  assert.match(markdown, /- Предложений: 5/);
  assert.match(markdown, /## Описание/);
  assert.match(markdown, /Подключить Cloudflare/);
  assert.match(markdown, /- \[Техническое_задание\.docx\]\(файлы\/%D0/);
});

test('решётка в описании не превращается в заголовок markdown', () => {
  const project = core.extractProject(buildProjectPage({ description: '# Задача\nсделать бота' }));

  assert.match(core.renderProjectMarkdown(project), /\\# Задача/);
});

test('заказ ложится на диск папкой с текстом, данными и местом под файлы', () => {
  const projectsDir = createProjectsDir();
  const project = core.extractProject(buildProjectPage());
  const result = handleCommand({ targetDir: path.join(projectsDir, 'переписки'), projectsDir }, {
    command: 'save-project',
    project,
  });

  const dir = path.join(projectsDir, '3230953-усиление-защиты-и-оптимизация-сервера');

  assert.equal(result.dir, dir);
  assert.equal(result.files, 1);
  assert.match(fs.readFileSync(path.join(dir, 'заказ.md'), 'utf8'), /Усиление защиты/);

  const record = JSON.parse(fs.readFileSync(path.join(dir, 'данные.json'), 'utf8'));

  assert.equal(record.id, '3230953');
  assert.equal(record.budget.maximum, 4500);
});

test('файл заказа собирается из кусков в папке своего заказа', () => {
  const projectsDir = createProjectsDir();
  const dirs = { targetDir: path.join(projectsDir, 'переписки'), projectsDir };
  handleCommand(dirs, { command: 'save-project', project: core.extractProject(buildProjectPage()) });

  const content = Buffer.from('первая часть и вторая часть', 'utf8');
  const half = Math.ceil(content.length / 2);

  const first = handleCommand(dirs, {
    command: 'save-project-file',
    projectId: '3230953',
    file: 'Техническое_задание.docx',
    part: 0,
    final: false,
    chunk: content.subarray(0, half).toString('base64'),
  });

  assert.equal(first.saved, false);

  const second = handleCommand(dirs, {
    command: 'save-project-file',
    projectId: '3230953',
    file: 'Техническое_задание.docx',
    part: 1,
    final: true,
    chunk: content.subarray(half).toString('base64'),
  });

  const filePath = path.join(
    projectsDir,
    '3230953-усиление-защиты-и-оптимизация-сервера',
    'файлы',
    'Техническое_задание.docx',
  );

  assert.equal(second.path, filePath);
  assert.equal(second.size, content.length);
  assert.equal(fs.readFileSync(filePath, 'utf8'), content.toString('utf8'));
});

test('имя файла заказа не выводит запись за пределы его папки', () => {
  const projectsDir = createProjectsDir();
  const result = handleCommand({ targetDir: projectsDir, projectsDir }, {
    command: 'save-project-file',
    projectId: '3230953',
    file: '../../../secrets.txt',
    chunk: Buffer.from('данные', 'utf8').toString('base64'),
  });

  assert.equal(path.dirname(result.path), path.join(projectsDir, '3230953', 'файлы'));
});

test('переименованный заказ не заводит вторую папку', () => {
  const projectsDir = createProjectsDir();
  const dirs = { targetDir: projectsDir, projectsDir };
  handleCommand(dirs, { command: 'save-project', project: core.extractProject(buildProjectPage()) });
  handleCommand(dirs, {
    command: 'save-project',
    project: core.extractProject(buildProjectPage({ name: 'Защита сервера' })),
  });

  assert.deepEqual(fs.readdirSync(projectsDir), ['3230953-защита-сервера']);
});

test('файлы заказа качает фоновый скрипт, а страница только читает заказ', () => {
  const projectRoot = path.resolve(__dirname, '..');
  const background = fs.readFileSync(path.join(projectRoot, 'src/background.js'), 'utf8');
  const pageScript = fs.readFileSync(path.join(projectRoot, 'src/project-content.js'), 'utf8');

  assert.match(background, /function downloadProjectFile[\s\S]{0,200}fetch\(item\.url/);
  assert.doesNotMatch(pageScript, /arrayBuffer/);
});

test('удачно сохранённый заказ не подменяет статус выгрузки переписок', () => {
  const background = fs.readFileSync(path.resolve(__dirname, '../src/background.js'), 'utf8');

  assert.match(background, /startsWith\('save-project'\)[\s\S]{0,40}return;/);
});

test('папка заказов по умолчанию лежит рядом с папкой переписок', () => {
  const { projectsDir } = require('../native_host/store.js').resolveDirs('F:\\Projects\\Kwork\\переписки');

  assert.equal(projectsDir, path.join('F:\\Projects\\Kwork', 'заказы'));
});
