(function initKworkProjectExportCore(root, factory) {
  const inboxCore = typeof module === 'object' && module.exports
    ? require('./inbox-core.js')
    : root.KworkInboxCore;
  const api = factory(inboxCore);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.KworkProjectExportCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProjectExportCore(inboxCore) {
  // Раскладка папки заказов повторяет папку переписок: заказ = папка с текстом,
  // данными и вложениями.
  const PROJECT_FILES_DIR_NAME = 'файлы';
  const PROJECT_MARKDOWN_NAME = 'заказ.md';
  const PROJECT_DATA_NAME = 'данные.json';
  const PROJECTS_DIR_NAME = 'заказы';
  const STATE_KEY = '"wantData":';
  const MAX_SLUG_LENGTH = 80;

  function buildProjectUrl(projectId) {
    const id = String(projectId ?? '').trim();
    return id ? `https://kwork.ru/projects/${id}/view` : null;
  }

  // Страница заказа отдаёт всё нужное одним объектом состояния, поэтому разбор
  // не зависит от вёрстки карточки: вырезается сбалансированный JSON и читается целиком.
  function extractWantData(markup) {
    if (typeof markup !== 'string') {
      return null;
    }

    const keyAt = markup.indexOf(STATE_KEY);
    const start = keyAt === -1 ? -1 : markup.indexOf('{', keyAt + STATE_KEY.length);
    if (start === -1) {
      return null;
    }

    let depth = 0;
    let insideString = false;
    let escaped = false;

    for (let index = start; index < markup.length; index += 1) {
      const symbol = markup[index];

      if (insideString) {
        if (escaped) {
          escaped = false;
        } else if (symbol === '\\') {
          escaped = true;
        } else if (symbol === '"') {
          insideString = false;
        }

        continue;
      }

      if (symbol === '"') {
        insideString = true;
      } else if (symbol === '{') {
        depth += 1;
      } else if (symbol === '}') {
        depth -= 1;

        if (depth === 0) {
          try {
            return JSON.parse(markup.slice(start, index + 1));
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  function toAmount(value) {
    const amount = Number(String(value ?? '').replace(/\s/g, ''));
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }

  function toCount(value) {
    const count = Number(value);
    return Number.isFinite(count) ? count : null;
  }

  // Имя файла в адресе закодировано процентами, но биржа встречается и с битой
  // последовательностью: обычное декодирование на ней падает и уносит с собой
  // весь разбор заказа, поэтому такой адрес берётся как есть.
  function decodeUrlPart(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function normalizeProjectFiles(files) {
    const used = new Set();

    return (Array.isArray(files) ? files : [])
      .map((item) => {
        const url = String(item?.url || '').trim();
        if (!url) {
          return null;
        }

        const name = String(item?.fname || item?.name || '').trim()
          || decodeUrlPart(url.split('/').pop() || '')
          || 'файл';
        let file = inboxCore.sanitizeFileName(name) || 'файл';
        const dot = file.lastIndexOf('.');
        const base = dot > 0 ? file.slice(0, dot) : file;
        const ext = dot > 0 ? file.slice(dot) : '';
        let counter = 2;

        while (used.has(file.toLowerCase())) {
          file = `${base} (${counter})${ext}`;
          counter += 1;
        }

        used.add(file.toLowerCase());

        return {
          id: item?.FID === undefined ? null : String(item.FID),
          name,
          url,
          file,
          size: toCount(item?.size),
        };
      })
      .filter(Boolean);
  }

  function normalizeProject(wantData, options = {}) {
    if (!wantData || typeof wantData !== 'object') {
      return null;
    }

    const id = String(wantData.id ?? '').trim();
    if (!id) {
      return null;
    }

    const client = wantData.user || {};

    return {
      id,
      url: options.url || buildProjectUrl(id),
      title: inboxCore.htmlToText(wantData.name) || `Заказ ${id}`,
      description: inboxCore.htmlToText(wantData.description),
      budget: {
        desired: toAmount(wantData.priceLimit),
        maximum: wantData.isHigherPrice ? toAmount(wantData.possiblePriceLimit) : null,
      },
      client: {
        id: client.USERID === undefined ? null : String(client.USERID),
        username: client.username ? String(client.username) : null,
        profileUrl: wantData.wantUserGetProfileUrl
          || (client.username ? `https://kwork.ru/user/${client.username}` : null),
        projectsCount: toCount(client.data?.wants_count),
        hiredPercent: toCount(client.data?.wants_hired_percent),
      },
      files: normalizeProjectFiles(wantData.files),
      deadlineDays: toCount(wantData.max_days),
      offers: toCount(wantData.kwork_count),
      views: toCount(wantData.views_dirty),
      timeLeft: wantData.timeLeft ? String(wantData.timeLeft) : null,
      status: wantData.altStatusHint?.title ? String(wantData.altStatusHint.title) : null,
      categoryId: wantData.category_id === undefined ? null : String(wantData.category_id),
      dates: {
        created: wantData.date_create || null,
        active: wantData.date_active || null,
        expires: wantData.date_expire || null,
      },
      extractedAt: options.extractedAt || new Date().toISOString(),
    };
  }

  function extractProject(markup, options = {}) {
    return normalizeProject(extractWantData(markup), options);
  }

  // Имя папки заказа начинается с его номера: заголовки на бирже повторяются,
  // а номер делает папку однозначной и сортируемой.
  function buildProjectSlug(project) {
    const id = String(project?.id ?? '').trim();
    if (!/^\d+$/.test(id)) {
      return null;
    }

    const title = String(project?.title ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');

    return title ? `${id}-${title}`.slice(0, MAX_SLUG_LENGTH).replace(/-$/, '') : id;
  }

  function formatAmount(amount) {
    return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
  }

  function formatBudget(budget) {
    const desired = budget?.desired ? formatAmount(budget.desired) : null;
    const maximum = budget?.maximum ? formatAmount(budget.maximum) : null;

    return { desired: desired || 'не указан', maximum };
  }

  function renderProjectMarkdown(project) {
    const budget = formatBudget(project?.budget);
    const files = Array.isArray(project?.files) ? project.files : [];
    const lines = [
      `# ${project?.title || 'Заказ'}`,
      '',
      `- Ссылка на заказ: ${project?.url || 'неизвестна'}`,
    ];

    if (project?.client?.username) {
      lines.push(`- Заказчик: ${project.client.username} — ${project.client.profileUrl}`);
    } else if (project?.client?.profileUrl) {
      lines.push(`- Заказчик: ${project.client.profileUrl}`);
    }

    if (project?.client?.projectsCount !== null && project?.client?.projectsCount !== undefined) {
      const hired = project.client.hiredPercent === null || project.client.hiredPercent === undefined
        ? ''
        : `, нанимает исполнителя в ${project.client.hiredPercent}% случаев`;
      lines.push(`- Заказов у заказчика на бирже: ${project.client.projectsCount}${hired}`);
    }

    lines.push(`- Желаемый бюджет: ${budget.desired}`);
    if (budget.maximum) {
      lines.push(`- Допустимый бюджет: ${budget.maximum}`);
    }

    if (project?.deadlineDays) {
      lines.push(`- Срок: до ${project.deadlineDays} дн.`);
    }

    if (project?.offers !== null && project?.offers !== undefined) {
      lines.push(`- Предложений: ${project.offers}`);
    }

    if (project?.views !== null && project?.views !== undefined) {
      lines.push(`- Просмотров: ${project.views}`);
    }

    if (project?.timeLeft) {
      lines.push(`- Осталось: ${project.timeLeft}`);
    }

    if (files.length > 0) {
      lines.push(`- Файлов: ${files.length} (папка «${PROJECT_FILES_DIR_NAME}»)`);
    }

    lines.push(
      `- Извлечено: ${inboxCore.formatMessageTime(project?.extractedAt || new Date().toISOString())}`,
      '',
      '## Описание',
      '',
      // Решётка в начале строки описания превратилась бы в заголовок и сбила
      // границы разделов, поэтому она экранируется.
      project?.description ? project.description.replace(/^(\s*)(#+)/gm, '$1\\$2') : 'Описание не указано.',
    );

    if (files.length > 0) {
      lines.push('', '## Файлы', '');
      for (const item of files) {
        lines.push(`- [${item.name}](${PROJECT_FILES_DIR_NAME}/${encodeURI(item.file)})`);
      }
    }

    return `${lines.join('\n').trim()}\n`;
  }

  return {
    PROJECTS_DIR_NAME,
    PROJECT_DATA_NAME,
    PROJECT_FILES_DIR_NAME,
    PROJECT_MARKDOWN_NAME,
    buildProjectSlug,
    buildProjectUrl,
    extractProject,
    extractWantData,
    formatAmount,
    normalizeProject,
    normalizeProjectFiles,
    renderProjectMarkdown,
  };
});
