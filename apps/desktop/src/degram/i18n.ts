// DeGram copy catalog (Phase 1301-13). Every string of the 1301-UI-SPEC "Copywriting Contract" lives here and
// reaches the UI through `useI18n().t.degram`. English is the base catalog (en.ts); Russian overrides it through
// `defineLocale` (ru.ts). fr, de, es and the other overlays fall back to English by design (UI-SPEC: "fr/de/es
// receive the English text"), so a missing translation can never render a blank.

type Count = number | string

const RU_PLURAL = new Intl.PluralRules('ru')

/** Russian plural form: one (1, 21, ...), few (2-4, 22-24, ...), many (0, 5-20, ...). */
function ruPlural(n: number, one: string, few: string, many: string): string {
  const rule = RU_PLURAL.select(n)

  return rule === 'one' ? one : rule === 'few' ? few : many
}

/** «0 B» / «12.3 KB» / «1.2 MB»; the ru catalog uses a decimal comma and Cyrillic unit names. */
function formatSize(bytes: number, locale: 'en' | 'ru'): string {
  const units = locale === 'ru' ? ['Б', 'КБ', 'МБ'] : ['B', 'KB', 'MB']
  const value = Math.max(0, bytes)
  const exp = value < 1024 ? 0 : value < 1024 * 1024 ? 1 : 2
  const scaled = value / 1024 ** exp
  const text = exp === 0 ? String(Math.round(scaled)) : scaled.toFixed(1)

  return `${locale === 'ru' ? text.replace('.', ',') : text} ${units[exp]}`
}

interface TitledCopy {
  title: string
  body: string
}

export interface DegramCopy {
  /** The product wordmark. Brand text, identical in every locale. */
  brand: string
  /** The DeGram sidebar rows (D-42): exactly these seven, in this order. */
  nav: {
    dg: string
    newSession: string
    graph: string
    validator: string
    connectors: string
    models: string
    projects: string
    menu: string
  }
  /** Commands that leave the current session (the project menu and the tray menu). */
  actions: { signOut: string }
  cta: {
    signIn: string
    chooseProject: string
    send: string
    stop: string
    retry: string
    narrowContext: string
    scopeSelection: string
    scopeWhole: string
    interrupted: string
    dgGraph: string
    dgFull: string
  }
  empty: {
    noProject: TitledCopy
    noAccessible: TitledCopy
    noDocuments: TitledCopy
  }
  context: {
    noDocument: string
    emptySelection: (document: string) => string
    truncated: (kept: Count, total: Count) => string
    missing: (what: string) => string
    /** Counts with the locale's plural forms (ru: 1 объект / 2 объекта / 5 объектов). Zero is shown, never hidden. */
    objects: (count: number) => string
    parameters: (count: number) => string
    rules: (count: number) => string
    fragments: (count: number) => string
    /** Payload size, e.g. «12.3 KB». */
    size: (bytes: number) => string
    /** Names of the parts of the payload a read can come back without (the «Missing: …» badge). */
    parts: { rules: string; selection: string; graph: string; objects: string; parameters: string; bytes: string }
    cardTitle: string
    payloadToggle: string
    payloadLabel: string
    refresh: string
    reading: string
    wholeDefinition: string
    /** A pinned document the read left out: «{document}: not included — {reason}» (D-29). */
    excluded: (document: string, reason: string) => string
  }
  /** The «Модели» screen (D-43). */
  models: { title: string }
  /** The Mapping sub-tab under each document of «Модели» (Phase 1303-10). Class and property names stay data. */
  mapping: {
    tab: string
    reading: string
    refresh: string
    progressLabel: string
    states: { confirmed: string; auto: string; suggested: string; ambiguous: string; unmapped: string }
    total: (count: Count) => string
    openQuestions: (count: Count) => string
    llmPending: string
    proposals: string
    noProposals: string
    waitingApply: string
    confirm: (count: number) => string
    confirming: string
    delivery: { queued: string; written: string; failed: string; unknown: string }
    applied: string
    answers: string
    /** Item rows in a proposal header (ru: 1 компонент / 2 компонента / 5 компонентов). */
    components: (count: number) => string
    /** The question types of the contract (§3, §7). */
    types: {
      batchAssign: string
      assign: string
      disambiguate: string
      mappingOrDesign: string
      batchParameters: string
      batchMeasures: string
      mapMeasure: string
    }
    kinds: { stream: string; measure: string; parameter: string }
    noProposal: string
    alternatives: (labels: string) => string
    elements: (count: number) => string
    values: (count: number) => string
    options: {
      acceptAll: string
      none: string
      notProperty: string
      both: string
      designError: (label: string) => string
    }
    details: string
    undo: string
    undoUnavailable: string
    sending: string
    undone: string
    noSession: string
    noSessionRevit: string
    start: string
    starting: string
    started: string
    notStarted: string
    signInFirst: string
    /** Accessible name of an item chip: a click shows the component on the canvas. */
    focus: (name: string) => string
    noComponent: string
    notFound: (name: string) => string
    /** Revit (1303-13): the DG Revit connector's sign-in state, its start and the rows it can show. */
    revitSignedIn: string
    revitSignInFirst: string
    /** The Revit start over an existing session: the connector reads the model again into a new session. */
    startAgain: string
    notStartedRevit: string
    /** Accessible name of a Revit element-group chip: a click selects its elements in Revit and zooms to them. */
    focusRevit: (name: string) => string
    notShowableRevit: string
    notFoundRevit: (name: string) => string
    /** A request DG refused for what it is (data.code of the JSON-RPC error). */
    refused: {
      sessionApplied: string
      answerGone: string
      questionGone: string
      optionInvalid: string
      sessionGone: string
      commitRequired: string
      commitConflict: string
      answerCommitted: string
      generic: (message: string) => string
    }
  }
  sessions: { empty: string }
  errors: {
    dgUnreachable: string
    modelUnavailable: string
    timeout: (seconds: Count) => string
    limit: (time: string) => string
    limitUnknown: string
    revitOff: string
    routesDisabled: string
    extensionNotLoaded: string
    revitBusy: string
    grasshopperOff: string
    pinnedGone: (document: string) => string
    sessionEnded: string
    /** CREDENTIALS_MISSING: the scope's backend holds no DG credential yet (plan 1301-18, G-5); not a session end. */
    credentialsMissing: (project: string) => string
    accessRevoked: (project: string) => string
    backendStartFailed: (project: string) => string
    policyDeny: (reason: string) => string
    isolation: (path: string) => string
    /** Not in the 1301-UI-SPEC table: outcomes the table has no sentence for (see 1301-14-SUMMARY deviations). */
    credentialsRefresh: string
    grasshopperBusy: string
    routesNotLoopback: string
    setupIncomplete: string
    lockedAction: string
    scopeNotSupported: string
    consentRequired: string
    unknown: string
  }
  format: { duration: (seconds: number) => string }
  bridge: {
    checking: string
    revit: string
    grasshopper: string
    /** Short state label shown next to the bridge name in the strip. */
    states: {
      ready: string
      pinned: string
      busy: string
      off: string
      setupIncomplete: string
      identityMismatch: string
    }
  }
  signIn: { connecting: string }
  document: {
    unsaved: string
    noIdentity: string
    retryRead: string
    refreshList: string
    unpin: string
    pickerLabel: string
  }
  dgPage: { reloadPage: string; reloadAria: string; externalBlocked: string; openInBrowser: string }
  confirm: {
    wholeTitle: string
    wholeBody: (objects: Count, parameters: Count, document: string, size: string) => string
    wholeSend: string
    wholeKeep: string
    signOutTitle: string
    signOutBody: string
    signOutConfirm: string
    keepWorking: string
    switchTitle: string
    switchBody: (project: string) => string
    switchConfirm: string
  }
  scope: {
    /** Accessible names of the scope-strip segments. */
    company: string
    project: string
    searchProjects: string
    isolationTitle: string
  }
  notice: { dismiss: string; grantRequired: (project: string) => string }
}

export const degramEn: DegramCopy = {
  brand: 'DeGram',
  nav: {
    dg: 'DG',
    newSession: 'New session',
    graph: 'Graph Viewer',
    validator: 'Model Viewer',
    connectors: 'Connectors',
    models: 'Models',
    projects: 'Projects',
    menu: 'Menu'
  },
  actions: { signOut: 'Sign out of DG' },
  cta: {
    signIn: 'Sign in with DG',
    chooseProject: 'Choose project',
    send: 'Send to model',
    stop: 'Stop response',
    retry: 'Retry request',
    narrowContext: 'Narrow context',
    scopeSelection: 'Selection',
    scopeWhole: 'Whole definition',
    interrupted: 'Interrupted',
    dgGraph: 'Project graph',
    dgFull: 'Full DG'
  },
  empty: {
    noProject: {
      title: 'Choose a project',
      body: 'DeGram works inside one DG project at a time. Choose a project you have access to — nothing is loaded until you do.'
    },
    noAccessible: {
      title: 'No projects available',
      body: "Your DG account isn't a member of any project yet. Ask a project owner for an invitation, then refresh."
    },
    noDocuments: {
      title: 'No open documents',
      body: 'Open a model in Revit 2024 or a definition in Grasshopper (Rhino 8), then refresh the list.'
    }
  },
  context: {
    noDocument: 'No document selected — the request uses project data only. Select a document to add a snapshot.',
    emptySelection: document =>
      `Nothing is selected in ${document}. Select elements there, or send without a snapshot.`,
    truncated: (kept, total) => `Truncated: ${kept} of ${total}`,
    missing: what => `Missing: ${what}`,
    objects: n => `${n} ${n === 1 ? 'object' : 'objects'}`,
    parameters: n => `${n} ${n === 1 ? 'parameter' : 'parameters'}`,
    rules: n => `${n} ${n === 1 ? 'rule' : 'rules'}`,
    fragments: n => `${n} ${n === 1 ? 'fragment' : 'fragments'}`,
    size: bytes => formatSize(bytes, 'en'),
    parts: {
      rules: 'rules',
      selection: 'selection',
      graph: 'project graph',
      objects: 'objects',
      parameters: 'parameters',
      bytes: 'size'
    },
    cardTitle: 'Context sent to the model',
    payloadToggle: 'Show the exact payload',
    payloadLabel: 'Exact payload',
    refresh: 'Re-read selection',
    reading: 'Reading',
    wholeDefinition: 'Whole definition',
    excluded: (document, reason) => `${document}: not included — ${reason}`
  },
  models: { title: 'Models' },
  mapping: {
    tab: 'Mapping',
    reading: 'Reading the mapping',
    refresh: 'Refresh the mapping',
    progressLabel: 'Mapping progress',
    states: {
      confirmed: 'Confirmed',
      auto: 'Auto by profile',
      suggested: 'Suggested',
      ambiguous: 'Ambiguous',
      unmapped: 'Unmapped'
    },
    total: n => `Total: ${n}`,
    openQuestions: n => `Open proposals: ${n}`,
    llmPending: 'The LLM proposal is still being prepared; this view updates on its own.',
    proposals: 'Proposals',
    noProposals: 'No open proposals.',
    waitingApply: 'Answers are drafts. Confirm once to queue only accepted decisions; other proposals remain open.',
    confirm: n => `Confirm and write (${n})`,
    confirming: 'Confirming…',
    delivery: {
      queued: 'Confirmed; waiting for the CAD connector to write',
      written: 'Written — confirmed by the CAD connector',
      failed: 'CAD write failed; no automatic replay',
      unknown: 'Delivery status unavailable'
    },
    applied: 'The session is applied.',
    answers: 'Decisions made',
    components: n => `${n} ${n === 1 ? 'component' : 'components'}`,
    types: {
      batchAssign: 'Accept proposed classes',
      assign: 'Assign a class',
      disambiguate: 'Choose roles',
      mappingOrDesign: 'Mapping or design error',
      batchParameters: 'Sliders as DG parameters',
      batchMeasures: 'Accept proposed properties',
      mapMeasure: 'Map an output to a property'
    },
    kinds: { stream: 'Element stream', measure: 'Calculation output', parameter: 'Slider' },
    noProposal: 'no proposal',
    alternatives: labels => `or ${labels}`,
    elements: n => `${n} ${n === 1 ? 'element' : 'elements'}`,
    values: n => `${n} ${n === 1 ? 'value' : 'values'}`,
    options: {
      acceptAll: 'Accept all',
      none: 'None of these',
      notProperty: 'Not a DG property',
      both: 'Both roles',
      designError: label => `${label} — rule violations are design errors`
    },
    details: 'Details',
    undo: 'Undo decision',
    undoUnavailable: 'The session is applied — undo is not available',
    sending: 'Sending the answer',
    undone: 'Decision undone',
    noSession: 'Mapping has not been run for this model yet.',
    noSessionRevit: 'There are no mapping sessions for this model yet.',
    start: 'Start mapping',
    starting: 'Starting the mapping',
    started: 'Mapping started — the session appears here in a few seconds.',
    notStarted: "CONNECTOR didn't start the mapping.",
    signInFirst: 'Sign in on CONNECTOR on the Grasshopper canvas to start the mapping.',
    focus: name => `Show ${name} on the Grasshopper canvas`,
    noComponent: 'No canvas component is known for this item',
    notFound: name => `${name} wasn't found on the Grasshopper canvas.`,
    revitSignedIn: 'Signed in to DG in Revit.',
    revitSignInFirst: 'Sign in to DG on the Revit ribbon: DG → Sign in',
    startAgain: 'Read the model again',
    notStartedRevit: "The DG connector in Revit didn't start the mapping.",
    focusRevit: name => `Show ${name} in Revit`,
    notShowableRevit: 'Only element groups can be shown in Revit',
    notFoundRevit: name => `No element of ${name} was found in the Revit model.`,
    refused: {
      sessionApplied: 'The session is already applied; nothing was changed.',
      answerGone: 'This decision was already undone. The list is refreshed.',
      questionGone: 'The proposal changed. The list is refreshed — answer again.',
      optionInvalid: "This option isn't offered any more. The list is refreshed.",
      sessionGone: 'The mapping session was not found. The list is refreshed.',
      commitRequired: 'Accept at least one proposal before confirming.',
      commitConflict: 'The mapping changed. Refresh and review accepted decisions before confirming again.',
      answerCommitted: 'This decision is already confirmed and cannot be undone.',
      generic: message => `DG refused the request: ${message}`
    }
  },
  sessions: { empty: 'There are no sessions in this project yet.' },
  errors: {
    dgUnreachable: "The DG server can't be reached. Check your network or VPN, then retry the request.",
    modelUnavailable:
      "The model service is unavailable. Your message wasn't processed; retry the request in a few minutes.",
    timeout: seconds => `No answer within ${seconds} s, so the request was stopped. Retry it, or narrow the selection.`,
    limit: time => `The model request limit is reached. Retry after ${time}, or ask the DG operator.`,
    limitUnknown: 'The model request limit is reached. Retry later, or ask the DG operator when it resets.',
    revitOff: "Revit isn't responding. Open Revit 2024 with the DeGram pyRevit extension, then refresh.",
    routesDisabled: 'pyRevit Routes are turned off. Enable Routes in pyRevit settings, restart Revit, then refresh.',
    extensionNotLoaded:
      'The DeGram extension isn\'t loaded in pyRevit. Follow the install step "pyRevit extension", then reload pyRevit.',
    revitBusy: 'Revit is busy (a command or dialog is open). Finish it in Revit, then retry the request.',
    grasshopperOff:
      "Grasshopper isn't responding. Place and enable the DG CANVAS LISTENER component on the canvas, then refresh.",
    pinnedGone: document =>
      `${document} is no longer open, or another file is active in its place. Select the document again — DeGram never switches documents on its own.`,
    sessionEnded: 'Your DG session has ended. Sign in again to continue; project data was cleared from this window.',
    credentialsMissing: project =>
      `DeGram has no DG access for ${project} in this window yet. Reopen the project; if it repeats, sign in again.`,
    accessRevoked: project =>
      `You no longer have access to ${project}. Its data and local chat history were removed from this computer.`,
    backendStartFailed: project => `The agent for project ${project} could not start.`,
    policyDeny: reason =>
      `DG policy doesn't allow sending this data to the model: ${reason}. Confirming won't override it — narrow the context or ask the project owner.`,
    isolation: path =>
      `DeGram can't start: its data folder overlaps a Hermes profile at ${path}. Move or remove that folder, then start DeGram again.`,
    credentialsRefresh: 'The DG access token expired and is being renewed. Retry the request.',
    grasshopperBusy:
      'Grasshopper is busy (a solution is running or a dialog is open). Wait for it, then retry the request.',
    routesNotLoopback:
      "pyRevit Routes aren't limited to this computer (loopback). Set the Routes host to 127.0.0.1 in pyRevit settings, restart Revit, then refresh.",
    setupIncomplete: "A setup step isn't finished for this application. Check the DeGram install steps, then refresh.",
    lockedAction: "DeGram doesn't allow this action. Nothing was changed.",
    scopeNotSupported: "This context scope isn't available for the selected document. Use the selection instead.",
    consentRequired: 'Sending the whole definition needs your confirmation; nothing was sent. Send again and confirm.',
    unknown: 'The request failed. Retry it; if it keeps failing, ask the DG operator.'
  },
  format: { duration: seconds => (seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds)} s`) },
  bridge: {
    checking: 'Checking',
    revit: 'Revit',
    grasshopper: 'Grasshopper',
    states: {
      ready: 'ready',
      pinned: 'pinned',
      busy: 'busy',
      off: 'off',
      setupIncomplete: 'setup',
      identityMismatch: 'other file'
    }
  },
  signIn: { connecting: 'Connecting to DG' },
  document: {
    unsaved: 'Not saved',
    noIdentity: "Can't be pinned: no document identity",
    retryRead: 'Retry read',
    refreshList: 'Refresh the document list',
    unpin: 'Unpin document',
    pickerLabel: 'Open documents'
  },
  dgPage: {
    reloadPage: 'Reload page',
    reloadAria: 'Reload the DG page',
    externalBlocked: "This link leads outside DG and won't open inside DeGram.",
    openInBrowser: 'Open in browser'
  },
  confirm: {
    wholeTitle: 'Send the whole definition?',
    wholeBody: (objects, parameters, document, size) =>
      `${objects} objects and ${parameters} parameters from ${document} (${size}) will go to the model. Review the payload in the context card first.`,
    wholeSend: 'Send whole definition',
    wholeKeep: 'Keep selection only',
    signOutTitle: 'Sign out of DG',
    signOutBody:
      "A response is still running. Signing out stops it and hides this project's chat until you sign in again.",
    signOutConfirm: 'Stop and sign out',
    keepWorking: 'Keep working',
    switchTitle: 'Switch project',
    switchBody: project => `The running response will be stopped. ${project} opens in a new chat.`,
    switchConfirm: 'Stop and switch'
  },
  scope: {
    company: 'Company',
    project: 'Project',
    searchProjects: 'Search projects',
    isolationTitle: 'Runtime isolation'
  },
  notice: {
    dismiss: 'Dismiss notice',
    grantRequired: project =>
      `DeGram access to ${project} has not been granted yet. Request it under Connectors or ask the project owner.`
  }
}

export const degramRu: DegramCopy = {
  brand: 'DeGram',
  nav: {
    dg: 'DG',
    newSession: 'Новая сессия',
    graph: 'Граф проекта',
    validator: 'Валидатор',
    connectors: 'Коннекторы',
    models: 'Модели',
    projects: 'Проекты',
    menu: 'Меню'
  },
  actions: { signOut: 'Выйти из DG' },
  cta: {
    signIn: 'Войти через DG',
    chooseProject: 'Выбрать проект',
    send: 'Отправить модели',
    stop: 'Остановить ответ',
    retry: 'Повторить запрос',
    narrowContext: 'Сузить контекст',
    scopeSelection: 'Выделение',
    scopeWhole: 'Всё определение',
    interrupted: 'Прервано',
    dgGraph: 'Граф проекта',
    dgFull: 'Полный DG'
  },
  empty: {
    noProject: {
      title: 'Выберите проект',
      body: 'DeGram работает внутри одного проекта DG. Выберите доступный вам проект — до выбора ничего не загружается.'
    },
    noAccessible: {
      title: 'Нет доступных проектов',
      body: 'Ваша учётная запись DG пока не состоит ни в одном проекте. Попросите владельца проекта прислать приглашение и обновите список.'
    },
    noDocuments: {
      title: 'Нет открытых документов',
      body: 'Откройте модель в Revit 2024 или определение в Grasshopper (Rhino 8) и обновите список.'
    }
  },
  context: {
    noDocument:
      'Документ не выбран — запрос использует только данные проекта. Выберите документ, чтобы добавить snapshot.',
    emptySelection: document => `В ${document} ничего не выделено. Выделите элементы или отправьте без snapshot.`,
    truncated: (kept, total) => `Сокращено: ${kept} из ${total}`,
    missing: what => `Нет данных: ${what}`,
    objects: n => `${n} ${ruPlural(n, 'объект', 'объекта', 'объектов')}`,
    parameters: n => `${n} ${ruPlural(n, 'параметр', 'параметра', 'параметров')}`,
    rules: n => `${n} ${ruPlural(n, 'правило', 'правила', 'правил')}`,
    fragments: n => `${n} ${ruPlural(n, 'фрагмент', 'фрагмента', 'фрагментов')}`,
    size: bytes => formatSize(bytes, 'ru'),
    parts: {
      rules: 'правила',
      selection: 'выделение',
      graph: 'граф проекта',
      objects: 'объекты',
      parameters: 'параметры',
      bytes: 'размер'
    },
    cardTitle: 'Контекст для модели',
    payloadToggle: 'Показать точный состав отправки',
    payloadLabel: 'Точный состав отправки',
    refresh: 'Перечитать выделение',
    reading: 'Чтение',
    wholeDefinition: 'Всё определение',
    excluded: (document, reason) => `${document}: не включён — ${reason}`
  },
  models: { title: 'Модели' },
  mapping: {
    tab: 'Меппинг',
    reading: 'Чтение меппинга',
    refresh: 'Обновить меппинг',
    progressLabel: 'Прогресс меппинга',
    states: {
      confirmed: 'Подтверждено',
      auto: 'Авто по профилю',
      suggested: 'Предложено',
      ambiguous: 'Неоднозначно',
      unmapped: 'Не сопоставлено'
    },
    total: n => `Всего: ${n}`,
    openQuestions: n => `Открытых предложений: ${n}`,
    llmPending: 'LLM ещё готовит предложение; этот вид обновится сам.',
    proposals: 'Предложения',
    noProposals: 'Открытых предложений нет.',
    waitingApply:
      'Ответы — черновики. Одно подтверждение отправит на запись только принятые решения; остальные предложения останутся открытыми.',
    confirm: n => `Подтвердить и записать (${n})`,
    confirming: 'Подтверждение…',
    delivery: {
      queued: 'Подтверждено; ожидает записи CAD-коннектором',
      written: 'Записано — подтверждено CAD-коннектором',
      failed: 'Ошибка записи в CAD; автоматического повтора нет',
      unknown: 'Статус записи недоступен'
    },
    applied: 'Сессия применена.',
    answers: 'Принятые решения',
    components: n => `${n} ${ruPlural(n, 'компонент', 'компонента', 'компонентов')}`,
    types: {
      batchAssign: 'Принять предложенные классы',
      assign: 'Назначить класс',
      disambiguate: 'Выбрать роли',
      mappingOrDesign: 'Меппинг или ошибка проекта',
      batchParameters: 'Слайдеры как параметры DG',
      batchMeasures: 'Принять предложенные свойства',
      mapMeasure: 'Выход → свойство DG'
    },
    kinds: { stream: 'Поток элементов', measure: 'Расчётный выход', parameter: 'Слайдер' },
    noProposal: 'нет предложения',
    alternatives: labels => `или ${labels}`,
    elements: n => `${n} ${ruPlural(n, 'элемент', 'элемента', 'элементов')}`,
    values: n => `${n} ${ruPlural(n, 'значение', 'значения', 'значений')}`,
    options: {
      acceptAll: 'Принять все',
      none: 'Ни один из вариантов',
      notProperty: 'Не свойство DG',
      both: 'Обе роли',
      designError: label => `${label} — нарушения правил — ошибки проекта`
    },
    details: 'Подробнее',
    undo: 'Отменить решение',
    undoUnavailable: 'Сессия применена — отмена недоступна',
    sending: 'Отправка ответа',
    undone: 'Решение отменено',
    noSession: 'Меппинг для этой модели ещё не запускался.',
    noSessionRevit: 'Для этой модели ещё нет сессий меппинга.',
    start: 'Запустить меппинг',
    starting: 'Запуск меппинга',
    started: 'Меппинг запущен — сессия появится здесь через несколько секунд.',
    notStarted: 'CONNECTOR не запустил меппинг.',
    signInFirst: 'Войдите в CONNECTOR на холсте Grasshopper, чтобы запустить меппинг.',
    focus: name => `Показать ${name} на холсте Grasshopper`,
    noComponent: 'Компонент на холсте для этого элемента неизвестен',
    notFound: name => `${name} не найден на холсте Grasshopper.`,
    revitSignedIn: 'Вход в DG в Revit выполнен.',
    revitSignInFirst: 'Войдите в DG на ленте Revit: DG → Вход',
    startAgain: 'Прочитать модель заново',
    notStartedRevit: 'Коннектор DG в Revit не запустил меппинг.',
    focusRevit: name => `Показать ${name} в Revit`,
    notShowableRevit: 'В Revit можно показать только группы элементов',
    notFoundRevit: name => `Ни один элемент ${name} не найден в модели Revit.`,
    refused: {
      sessionApplied: 'Сессия уже применена — ничего не изменено.',
      answerGone: 'Это решение уже отменено. Список обновлён.',
      questionGone: 'Предложение изменилось. Список обновлён — ответьте ещё раз.',
      optionInvalid: 'Этот вариант больше не предлагается. Список обновлён.',
      sessionGone: 'Сессия меппинга не найдена. Список обновлён.',
      commitRequired: 'Перед подтверждением примите хотя бы одно предложение.',
      commitConflict: 'Меппинг изменился. Обновите список и проверьте принятые решения перед повторным подтверждением.',
      answerCommitted: 'Решение уже подтверждено — отменить его нельзя.',
      generic: message => `DG отклонил запрос: ${message}`
    }
  },
  sessions: { empty: 'В этом проекте пока нет сеансов.' },
  errors: {
    dgUnreachable: 'Сервер DG недоступен. Проверьте сеть или VPN и повторите запрос.',
    modelUnavailable: 'Сервис модели недоступен. Сообщение не обработано; повторите запрос через несколько минут.',
    timeout: seconds => `Ответа нет за ${seconds} с, запрос остановлен. Повторите его или сократите выделение.`,
    limit: time => `Лимит запросов к модели исчерпан. Повторите после ${time} или обратитесь к оператору DG.`,
    limitUnknown:
      'Лимит запросов к модели исчерпан. Повторите позже или уточните у оператора DG, когда лимит обновится.',
    revitOff: 'Revit не отвечает. Откройте Revit 2024 с расширением DeGram для pyRevit и обновите список.',
    routesDisabled:
      'Маршруты pyRevit (Routes) выключены. Включите их в настройках pyRevit, перезапустите Revit и обновите список.',
    extensionNotLoaded:
      'Расширение DeGram не загружено в pyRevit. Выполните шаг установки «Расширение pyRevit» и перезагрузите pyRevit.',
    revitBusy: 'Revit занят (открыта команда или диалог). Завершите её в Revit и повторите запрос.',
    grasshopperOff:
      'Grasshopper не отвечает. Поставьте на канвас компонент DG CANVAS LISTENER, включите его и обновите список.',
    pinnedGone: document =>
      `${document} больше не открыт или вместо него активен другой файл. Выберите документ заново — DeGram не переключает документы сам.`,
    sessionEnded: 'Сеанс DG завершён. Войдите снова, чтобы продолжить; данные проекта убраны из этого окна.',
    credentialsMissing: project =>
      `У DeGram пока нет доступа к DG для ${project} в этом окне. Откройте проект заново; если ошибка повторится, войдите снова.`,
    accessRevoked: project =>
      `У вас больше нет доступа к ${project}. Его данные и локальная история чата удалены с этого компьютера.`,
    backendStartFailed: project => `Не удалось запустить агента для проекта ${project}.`,
    policyDeny: reason =>
      `Политика DG не разрешает отправку этих данных модели: ${reason}. Подтверждение это не отменит — сузьте контекст или обратитесь к владельцу проекта.`,
    isolation: path =>
      `DeGram не может запуститься: его папка данных пересекается с профилем Hermes в ${path}. Перенесите или удалите эту папку и запустите DeGram снова.`,
    credentialsRefresh: 'Токен доступа DG истёк и обновляется. Повторите запрос.',
    grasshopperBusy: 'Grasshopper занят (идёт расчёт или открыт диалог). Дождитесь его и повторите запрос.',
    routesNotLoopback:
      'Маршруты pyRevit (Routes) доступны не только с этого компьютера (loopback). Укажите хост Routes 127.0.0.1 в настройках pyRevit, перезапустите Revit и обновите список.',
    setupIncomplete: 'Для этого приложения не завершена настройка. Проверьте шаги установки DeGram и обновите список.',
    lockedAction: 'DeGram не разрешает это действие. Ничего не изменено.',
    scopeNotSupported: 'Этот объём контекста недоступен для выбранного документа. Используйте выделение.',
    consentRequired:
      'Отправка всего определения требует вашего подтверждения; ничего не отправлено. Отправьте снова и подтвердите.',
    unknown: 'Запрос не выполнен. Повторите его; если ошибка повторяется, обратитесь к оператору DG.'
  },
  format: { duration: seconds => (seconds >= 120 ? `${Math.round(seconds / 60)} мин` : `${Math.round(seconds)} с`) },
  bridge: {
    checking: 'Проверка',
    revit: 'Revit',
    grasshopper: 'Grasshopper',
    states: {
      ready: 'готов',
      pinned: 'закреплён',
      busy: 'занят',
      off: 'выкл',
      setupIncomplete: 'настройка',
      identityMismatch: 'другой файл'
    }
  },
  signIn: { connecting: 'Подключение к DG' },
  document: {
    unsaved: 'Не сохранён',
    noIdentity: 'Нельзя закрепить: нет идентификатора документа',
    retryRead: 'Повторить чтение',
    refreshList: 'Обновить список документов',
    unpin: 'Открепить документ',
    pickerLabel: 'Открытые документы'
  },
  dgPage: {
    reloadPage: 'Перезагрузить страницу',
    reloadAria: 'Обновить страницу DG',
    externalBlocked: 'Ссылка ведёт за пределы DG и не открывается внутри DeGram.',
    openInBrowser: 'Открыть в браузере'
  },
  confirm: {
    wholeTitle: 'Отправить всё определение?',
    wholeBody: (objects, parameters, document, size) =>
      `В модель уйдут ${objects} объектов и ${parameters} параметров из ${document} (${size}). Сначала проверьте состав в карточке контекста.`,
    wholeSend: 'Отправить всё определение',
    wholeKeep: 'Оставить только выделение',
    signOutTitle: 'Выход из DG',
    signOutBody: 'Ответ ещё формируется. Выход остановит его и скроет чат проекта до повторного входа.',
    signOutConfirm: 'Остановить и выйти',
    keepWorking: 'Продолжить работу',
    switchTitle: 'Смена проекта',
    switchBody: project => `Текущий ответ будет остановлен. ${project} откроется в новом чате.`,
    switchConfirm: 'Остановить и переключить'
  },
  scope: {
    company: 'Компания',
    project: 'Проект',
    searchProjects: 'Поиск проектов',
    isolationTitle: 'Изоляция среды выполнения'
  },
  notice: {
    dismiss: 'Закрыть уведомление',
    grantRequired: project =>
      `Доступ DeGram к проекту ${project} ещё не выдан. Запросите его в разделе «Коннекторы» или у владельца проекта.`
  }
}
