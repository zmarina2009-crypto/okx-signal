# OKX Signal Pro v2.0

GitHub Pages-ready PWA.

## Что исправлено
- Только полностью закрытые свечи (`confirm=1`), без текущей незакрытой свечи.
- OKX REST API: `openapi.okx.com`.
- Таймаут 8 секунд и до 3 попыток.
- Явное состояние ошибки вместо вечной «Загрузка…».
- Свечной график + SMA fast/slow.
- 1H trend filter.
- Защита от дублей сигналов.
- Оценка результата через 1/3/6/12 свечей.
- PWA manifest с иконками 192/512.
- Service worker не кэширует API.
- Автоторговля отключена.

## Установка
Распаковать архив и заменить файлы в репозитории GitHub Pages. В Settings → Pages выбрать Deploy from branch. Открыть HTTPS-адрес в Chrome Android и выбрать «Установить»/«Добавить на главный экран».

Telegram/private OKX API следует подключать через backend: секреты нельзя хранить в браузерном JavaScript.
