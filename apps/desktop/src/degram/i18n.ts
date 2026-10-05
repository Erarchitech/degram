// DeGram copy catalog (Phase 1301-13). Every string of the 1301-UI-SPEC "Copywriting Contract" lives here and
// reaches the UI through `useI18n().t.degram`. English is the base catalog (en.ts); Russian overrides it through
// `defineLocale` (ru.ts). fr, de, es and the other overlays fall back to English by design (UI-SPEC: "fr/de/es
// receive the English text"), so a missing translation can never render a blank.

type Count = number | string

interface TitledCopy {
  title: string
  body: string
}

export interface DegramCopy {
  /** The product wordmark. Brand text, identical in every locale. */
  brand: string
  nav: { dg: string }
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
  }
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
    accessRevoked: (project: string) => string
    policyDeny: (reason: string) => string
    isolation: (path: string) => string
  }
  bridge: { checking: string; revit: string; grasshopper: string }
  signIn: { connecting: string }
  document: { unsaved: string; noIdentity: string; retryRead: string }
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
}

export const degramEn: DegramCopy = {
  brand: 'DeGram',
  nav: { dg: 'DG' },
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
    missing: what => `Missing: ${what}`
  },
  errors: {
    dgUnreachable: "The DG server can't be reached. Check your network or VPN, then retry the request.",
    modelUnavailable:
      "The model service is unavailable. Your message wasn't processed; retry the request in a few minutes.",
    timeout: seconds => `No answer within ${seconds} s, so the request was stopped. Retry it, or narrow the selection.`,
    limit: time => `The request limit for this project is reached. Retry after ${time}, or ask the DG operator.`,
    limitUnknown: 'The request limit for this project is reached. Retry later, or ask the DG operator when it resets.',
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
    accessRevoked: project =>
      `You no longer have access to ${project}. Its data and local chat history were removed from this computer.`,
    policyDeny: reason =>
      `DG policy doesn't allow sending this data to the model: ${reason}. Confirming won't override it — narrow the context or ask the project owner.`,
    isolation: path =>
      `DeGram can't start: its data folder overlaps a Hermes profile at ${path}. Move or remove that folder, then start DeGram again.`
  },
  bridge: { checking: 'Checking', revit: 'Revit', grasshopper: 'Grasshopper' },
  signIn: { connecting: 'Connecting to DG' },
  document: {
    unsaved: 'Not saved',
    noIdentity: "Can't be pinned: no document identity",
    retryRead: 'Retry read'
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
  }
}

export const degramRu: DegramCopy = {
  brand: 'DeGram',
  nav: { dg: 'DG' },
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
    missing: what => `Нет данных: ${what}`
  },
  errors: {
    dgUnreachable: 'Сервер DG недоступен. Проверьте сеть или VPN и повторите запрос.',
    modelUnavailable: 'Сервис модели недоступен. Сообщение не обработано; повторите запрос через несколько минут.',
    timeout: seconds => `Ответа нет за ${seconds} с, запрос остановлен. Повторите его или сократите выделение.`,
    limit: time => `Достигнут лимит запросов для проекта. Повторите после ${time} или обратитесь к оператору DG.`,
    limitUnknown:
      'Достигнут лимит запросов для проекта. Повторите позже или уточните у оператора DG, когда лимит обновится.',
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
    accessRevoked: project =>
      `У вас больше нет доступа к ${project}. Его данные и локальная история чата удалены с этого компьютера.`,
    policyDeny: reason =>
      `Политика DG не разрешает отправку этих данных модели: ${reason}. Подтверждение это не отменит — сузьте контекст или обратитесь к владельцу проекта.`,
    isolation: path =>
      `DeGram не может запуститься: его папка данных пересекается с профилем Hermes в ${path}. Перенесите или удалите эту папку и запустите DeGram снова.`
  },
  bridge: { checking: 'Проверка', revit: 'Revit', grasshopper: 'Grasshopper' },
  signIn: { connecting: 'Подключение к DG' },
  document: {
    unsaved: 'Не сохранён',
    noIdentity: 'Нельзя закрепить: нет идентификатора документа',
    retryRead: 'Повторить чтение'
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
  }
}
