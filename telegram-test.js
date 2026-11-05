(() => {
  "use strict";
  const button = document.getElementById("telegramTestButton");
  const status = document.getElementById("telegramTestStatus");
  if (!button || !status) return;

  const endpoint = "https://telegram-worker-production-1f09.up.railway.app/test";
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Отправка…";
    status.textContent = "Отправляю тестовое сообщение…";
    status.style.color = "";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        mode: "cors",
        cache: "no-store"
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.ok) {
        status.textContent = "Тест отправлен в Telegram";
        status.style.color = "#27e58a";
      } else if (response.status === 429) {
        status.textContent = "Повторите тест через 30 секунд";
        status.style.color = "#ffd166";
      } else if (response.status === 403) {
        status.textContent = "Запрос отклонён: проверьте адрес приложения";
        status.style.color = "#ff5f68";
      } else {
        status.textContent = "Не удалось отправить тест. Проверьте Telegram worker";
        status.style.color = "#ff5f68";
      }
    } catch (error) {
      status.textContent = "Нет связи с Telegram worker";
      status.style.color = "#ff5f68";
    } finally {
      button.textContent = originalText;
      window.setTimeout(() => { button.disabled = false; }, 30_000);
    }
  });
})();