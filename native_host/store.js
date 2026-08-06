// Запись переписок и заказов на диск: папка на диалог и папка на заказ,
// в каждой — текст, полные данные и вложения.

const fs = require('node:fs');
const path = require('node:path');

const core = require('../src/inbox-core.js');
const projectCore = require('../src/project-core.js');

const DATA_DIR_NAME = 'data';
const DIALOG_LIST_FILE = '_dialogs.json';
const PART_SUFFIX = '.part';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getServiceDir(targetDir) {
  return ensureDir(path.join(targetDir, DATA_DIR_NAME));
}

function getDialogDir(targetDir, slug) {
  return path.join(targetDir, slug);
}

function getAttachmentDir(targetDir, slug) {
  return path.join(getDialogDir(targetDir, slug), core.ATTACHMENT_DIR_NAME);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function moveFile(fromPath, toPath) {
  if (!fs.existsSync(fromPath) || fs.existsSync(toPath)) {
    return false;
  }

  ensureDir(path.dirname(toPath));
  fs.renameSync(fromPath, toPath);
  return true;
}

// Первые версии складывали переписки плоско: `<ник>.md` в корне и `data/<ник>.json`.
// Файлы переносятся в папку диалога при первом же обращении, чтобы раскладка
// не оставалась смешанной.
function migrateDialogLayout(targetDir, slug) {
  const dialogDir = getDialogDir(targetDir, slug);
  const movedMarkdown = moveFile(
    path.join(targetDir, `${slug}.md`),
    path.join(dialogDir, core.DIALOG_MARKDOWN_NAME),
  );
  const movedData = moveFile(
    path.join(targetDir, DATA_DIR_NAME, `${slug}.json`),
    path.join(dialogDir, core.DIALOG_DATA_NAME),
  );

  return movedMarkdown || movedData;
}

function migrateLayout(targetDir) {
  if (!fs.existsSync(targetDir)) {
    return { migrated: 0 };
  }

  const slugs = new Set();

  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      slugs.add(entry.name.replace(/\.md$/, ''));
    }
  }

  const dataDir = path.join(targetDir, DATA_DIR_NAME);
  if (fs.existsSync(dataDir)) {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
        slugs.add(entry.name.replace(/\.json$/, ''));
      }
    }
  }

  let migrated = 0;
  for (const slug of slugs) {
    if (migrateDialogLayout(targetDir, slug)) {
      migrated += 1;
    }
  }

  return { migrated };
}

function saveDialog(targetDir, { dialog, sample }) {
  const slug = core.buildDialogSlug(dialog?.key);
  if (!slug) {
    throw new Error('переписка без имени диалога');
  }

  if (core.isServiceDialogKey(dialog?.key) || !Array.isArray(dialog?.messages) || dialog.messages.length === 0) {
    return { path: null, messages: 0, skipped: true };
  }

  ensureDir(targetDir);
  migrateDialogLayout(targetDir, slug);

  const dialogDir = ensureDir(getDialogDir(targetDir, slug));
  const jsonPath = path.join(dialogDir, core.DIALOG_DATA_NAME);
  const markdownPath = path.join(dialogDir, core.DIALOG_MARKDOWN_NAME);

  const previous = readJson(jsonPath);
  const dialogContext = { dialogKey: dialog.key, clientId: dialog.clientId || previous?.clientId || null };
  const messages = core.filterDialogMessages(
    core.mergeMessages(previous?.messages, dialog?.messages),
    dialogContext,
  );
  const record = {
    key: dialog.key,
    title: dialog.title || previous?.title || dialog.key,
    url: dialog.url || previous?.url || `https://kwork.ru/inbox/${dialog.key}`,
    clientId: dialog.clientId || previous?.clientId || null,
    historyStrategy: dialog.strategy || previous?.historyStrategy || null,
    historyComplete: dialog.complete === undefined ? previous?.historyComplete ?? null : dialog.complete,
    ownerId: dialog.ownerId || previous?.ownerId || null,
    updatedAt: dialog.updatedAt || new Date().toISOString(),
    messages,
    samples: sample ? [...(previous?.samples || []), sample].slice(-3) : (previous?.samples || []),
  };

  writeFileAtomic(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileAtomic(markdownPath, core.renderDialogMarkdown(record));

  return {
    path: markdownPath,
    messages: messages.length,
    attachments: core.resolveAttachmentFiles(messages).length,
  };
}

function resolveAttachmentPath(targetDir, dialogKey, fileName) {
  const slug = core.buildDialogSlug(dialogKey);
  if (!slug) {
    throw new Error('вложение без имени диалога');
  }

  const safeName = core.sanitizeFileName(fileName);
  if (!safeName) {
    throw new Error('вложение без имени файла');
  }

  const dir = getAttachmentDir(targetDir, slug);
  const filePath = path.join(dir, safeName);
  if (path.dirname(filePath) !== dir) {
    throw new Error('имя вложения уводит запись за пределы папки');
  }

  return { dir, filePath };
}

// Файлы приходят кусками: пока идёт передача, данные копятся во временном файле,
// и только последний кусок делает вложение видимым под настоящим именем.
function saveAttachment(targetDir, message) {
  const { dir, filePath } = resolveAttachmentPath(targetDir, message?.dialogKey, message?.file);
  ensureDir(dir);

  const partPath = `${filePath}${PART_SUFFIX}`;
  const chunk = Buffer.from(String(message?.chunk || ''), 'base64');
  const part = Number(message?.part) || 0;

  if (part === 0) {
    fs.writeFileSync(partPath, chunk);
  } else {
    fs.appendFileSync(partPath, chunk);
  }

  if (message?.final === false) {
    return { path: partPath, part, saved: false };
  }

  fs.rmSync(filePath, { force: true });
  fs.renameSync(partPath, filePath);

  return { path: filePath, size: fs.statSync(filePath).size, saved: true };
}

function listAttachments(targetDir, dialogKey) {
  const slug = core.buildDialogSlug(dialogKey);
  if (!slug) {
    throw new Error('запрос вложений без имени диалога');
  }

  const dir = getAttachmentDir(targetDir, slug);
  if (!fs.existsSync(dir)) {
    return { files: [] };
  }

  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(PART_SUFFIX))
    .map((entry) => ({ file: entry.name, size: fs.statSync(path.join(dir, entry.name)).size }));

  return { files };
}

function saveKnownDialogs(targetDir, dialogKeys) {
  const keys = [...new Set((dialogKeys || [])
    .map((key) => String(key).trim())
    .filter((key) => key && !core.isServiceDialogKey(key)))].sort();
  const listPath = path.join(getServiceDir(targetDir), DIALOG_LIST_FILE);
  const previous = readJson(listPath)?.dialogKeys || [];
  const merged = [...new Set([...previous, ...keys])].filter((key) => !core.isServiceDialogKey(key)).sort();

  writeFileAtomic(listPath, `${JSON.stringify({ updatedAt: new Date().toISOString(), dialogKeys: merged }, null, 2)}\n`);

  return { path: listPath, dialogs: merged.length };
}

// Когда список переписок собрать не удалось, на диск ложится срез страницы:
// по нему видно, что именно вернула биржа, без доступа к браузеру пользователя.
function saveDiagnostics(targetDir, diagnostics) {
  const filePath = path.join(getServiceDir(targetDir), '_diagnostics.json');
  writeFileAtomic(filePath, `${JSON.stringify({ at: new Date().toISOString(), ...diagnostics }, null, 2)}\n`);
  return { path: filePath };
}

// Папка заказов лежит рядом с папкой переписок, если мост не настроен на другую:
// у обеих один корень, и агенту не нужно знать про две разные настройки.
function resolveDirs(value) {
  const dirs = typeof value === 'string' ? { targetDir: value } : { ...(value || {}) };
  const targetDir = String(dirs.targetDir || '').trim();

  return {
    targetDir,
    projectsDir: String(dirs.projectsDir || '').trim()
      || path.join(path.dirname(targetDir), projectCore.PROJECTS_DIR_NAME),
  };
}

// Номер заказа известен и при записи файлов, а имя папки содержит ещё и заголовок,
// поэтому папка ищется по номеру, а не собирается заново.
function findProjectDir(projectsDir, projectId) {
  const id = String(projectId ?? '').trim();
  if (!/^\d+$/.test(id)) {
    throw new Error('заказ без номера');
  }

  if (fs.existsSync(projectsDir)) {
    const existing = fs.readdirSync(projectsDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && (entry.name === id || entry.name.startsWith(`${id}-`)));

    if (existing) {
      return path.join(projectsDir, existing.name);
    }
  }

  return path.join(projectsDir, id);
}

function saveProject(projectsDir, { project }) {
  const slug = projectCore.buildProjectSlug(project);
  if (!slug) {
    throw new Error('заказ без номера');
  }

  const previousDir = findProjectDir(projectsDir, project.id);
  const projectDir = path.join(projectsDir, slug);

  if (previousDir !== projectDir && fs.existsSync(previousDir)) {
    fs.renameSync(previousDir, projectDir);
  }

  ensureDir(projectDir);

  const markdownPath = path.join(projectDir, projectCore.PROJECT_MARKDOWN_NAME);
  writeFileAtomic(
    path.join(projectDir, projectCore.PROJECT_DATA_NAME),
    `${JSON.stringify(project, null, 2)}\n`,
  );
  writeFileAtomic(markdownPath, projectCore.renderProjectMarkdown(project));

  return {
    path: markdownPath,
    dir: projectDir,
    files: Array.isArray(project.files) ? project.files.length : 0,
  };
}

function saveProjectFile(projectsDir, message) {
  const dir = path.join(findProjectDir(projectsDir, message?.projectId), projectCore.PROJECT_FILES_DIR_NAME);
  const safeName = core.sanitizeFileName(message?.file);
  if (!safeName) {
    throw new Error('файл заказа без имени');
  }

  const filePath = path.join(dir, safeName);
  if (path.dirname(filePath) !== dir) {
    throw new Error('имя файла уводит запись за пределы папки заказа');
  }

  ensureDir(dir);

  const partPath = `${filePath}${PART_SUFFIX}`;
  const chunk = Buffer.from(String(message?.chunk || ''), 'base64');
  const part = Number(message?.part) || 0;

  if (part === 0) {
    fs.writeFileSync(partPath, chunk);
  } else {
    fs.appendFileSync(partPath, chunk);
  }

  if (message?.final === false) {
    return { path: partPath, part, saved: false };
  }

  fs.rmSync(filePath, { force: true });
  fs.renameSync(partPath, filePath);

  return { path: filePath, size: fs.statSync(filePath).size, saved: true };
}

function handleCommand(dirs, message) {
  const { targetDir, projectsDir } = resolveDirs(dirs);

  if (message?.command === 'save-project') {
    return saveProject(projectsDir, message);
  }

  if (message?.command === 'save-project-file') {
    return saveProjectFile(projectsDir, message);
  }

  if (message?.command === 'save-diagnostics') {
    return saveDiagnostics(targetDir, message.diagnostics || {});
  }

  if (message?.command === 'save-dialog') {
    return saveDialog(targetDir, message);
  }

  if (message?.command === 'save-attachment') {
    return saveAttachment(targetDir, message);
  }

  if (message?.command === 'list-attachments') {
    return listAttachments(targetDir, message.dialogKey);
  }

  if (message?.command === 'migrate-layout') {
    return migrateLayout(targetDir);
  }

  if (message?.command === 'known-dialogs') {
    return saveKnownDialogs(targetDir, message.dialogKeys);
  }

  throw new Error(`неизвестная команда: ${message?.command}`);
}

module.exports = {
  handleCommand,
  listAttachments,
  migrateLayout,
  resolveDirs,
  saveAttachment,
  saveDialog,
  saveDiagnostics,
  saveKnownDialogs,
  saveProject,
  saveProjectFile,
};
