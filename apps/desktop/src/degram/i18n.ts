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
  nav: { dg: string }
  /** Commands that leave the current session (the project menu and the tray menu). */
  actions: { signOut: string }
  cta: {
    selectDocument: string
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
  /** The scope strip's own copy (D-29): how many documents are pinned. */
  strip: { documentsCount: (count: number) => string }
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
    document: string
    searchProjects: string
    isolationTitle: string
  }
  notice: { dismiss: string }
  /** The "Connection to DG" panel: the DeGram pairing token from the DG Connectors tab (Phase 1301-17). */
  pairing: {
    title: string
    body: string
    fieldLabel: string
    connect: string
    disconnect: string
    stored: string
    connected: (user: string, company: string | null) => string
    revoked: string
    mismatch: (user: string) => string
    invalid: string
    unavailable: string
    failed: string
    disconnectHint: string
    revokedNotice: string
    requiredNotice: string
  }
}

export const degramEn: DegramCopy = {
  brand: 'DeGram',
  nav: { dg: 'DG' },
  actions: { signOut: 'Sign out of DG' },
  cta: {
    selectDocument: 'Select document',
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
  strip: { documentsCount: n => `Documents: ${n}` },
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
    document: 'Document',
    searchProjects: 'Search projects',
    isolationTitle: 'Runtime isolation'
  },
  notice: { dismiss: 'Dismiss notice' },
  pairing: {
    title: 'Connection to DG',
    body: 'Paste the pairing token you created on the DG Connectors tab (DeGram card). DeGram keeps it encrypted on this computer and uses it to act as you on the project you choose.',
    fieldLabel: 'Pairing token',
    connect: 'Connect',
    disconnect: 'Disconnect',
    stored: 'Paired. The token is used when you open a project.',
    connected: (user, company) => `Connected as ${user}${company ? ` · ${company}` : ''}.`,
    revoked: 'This pairing was revoked in DG. Create a new pairing on the Connectors tab and paste it here.',
    mismatch: user => `This pairing belongs to another DG user than ${user}. Paste a pairing you created yourself.`,
    invalid: "That isn't a DeGram pairing token. Copy it again from the DG Connectors tab; it starts with dgp_.",
    unavailable:
      "This computer can't encrypt the pairing token, so DeGram can't keep it. Signing in with DG keeps working.",
    failed: "The pairing couldn't be saved. Retry; if it keeps failing, restart DeGram.",
    disconnectHint:
      'Disconnecting forgets the token on this computer. To end it everywhere, revoke it on the DG Connectors tab.',
    revokedNotice: 'The pairing token was revoked. Create a new one on the Connectors tab in DG (in a browser) and paste it below.',
    requiredNotice: 'Paste a pairing token before choosing a project.'
  }
}

export const degramRu: DegramCopy = {
  brand: 'DeGram',
  nav: { dg: 'DG' },
  actions: { signOut: 'Выйти из DG' },
  cta: {
    selectDocument: 'Выбрать документ',
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
  strip: { documentsCount: n => `Документы: ${n}` },
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
    document: 'Документ',
    searchProjects: 'Поиск проектов',
    isolationTitle: 'Изоляция среды выполнения'
  },
  notice: { dismiss: 'Закрыть уведомление' },
  pairing: {
    title: 'Подключение к DG',
    body: 'Вставьте токен сопряжения, созданный во вкладке Connectors в DG (карточка DeGram). DeGram хранит его зашифрованным на этом компьютере и действует от вашего имени в выбранном проекте.',
    fieldLabel: 'Токен сопряжения',
    connect: 'Подключить',
    disconnect: 'Отключить',
    stored: 'Сопряжение сохранено. Токен используется при открытии проекта.',
    connected: (user, company) => `Подключено: ${user}${company ? ` · ${company}` : ''}.`,
    revoked: 'Сопряжение отозвано в DG. Создайте новое во вкладке Connectors и вставьте его сюда.',
    mismatch: user =>
      `Это сопряжение принадлежит другому пользователю DG, а не ${user}. Вставьте сопряжение, созданное вами.`,
    invalid: 'Это не токен сопряжения DeGram. Скопируйте его снова во вкладке Connectors в DG; он начинается с dgp_.',
    unavailable:
      'Этот компьютер не может зашифровать токен сопряжения, поэтому DeGram не может его хранить. Вход через DG продолжает работать.',
    failed: 'Не удалось сохранить сопряжение. Повторите; если ошибка повторяется, перезапустите DeGram.',
    disconnectHint:
      'Отключение удаляет токен с этого компьютера. Чтобы погасить его везде, отзовите его во вкладке Connectors в DG.',
    revokedNotice: 'Токен сопряжения отозван. Создайте новый на вкладке Connectors в DG (в браузере) и вставьте его ниже.',
    requiredNotice: 'Сначала вставьте токен сопряжения'
  }
}
