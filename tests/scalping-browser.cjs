const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:4173/index.html";
const OUT = path.join(process.cwd(), "test-results");
fs.mkdirSync(OUT, { recursive: true });

const checks = [];
const pageErrors = [];
const networkFailures = [];

function record(name, status, details = {}) {
  checks.push({ name, status, ...details });
  console.log(`[${status}] ${name}${details.message ? `: ${details.message}` : ""}`);
}

async function waitForStatus(page, expectedText, timeout = 240000) {
  await page.waitForFunction(
    ({ expectedText }) => {
      const el = document.getElementById("btStatus");
      const text = el?.textContent || "";
      return text.includes(expectedText) || /^(Ошибка теста|Ошибка сравнения|Ошибка адаптивного сравнения|Ошибка анализа фаз)/.test(text);
    },
    { expectedText },
    { timeout }
  );
  return (await page.locator("#btStatus").innerText()).trim();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => {
    const url = request.url();
    if (url.includes("okx.com/api/")) networkFailures.push({ url, error: request.failure()?.errorText || "request failed" });
  });

  try {
    const response = await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (!response || !response.ok()) throw new Error(`App page returned HTTP ${response?.status()}`);
    await page.waitForSelector("#smaTester", { timeout: 15000 });
    await page.waitForSelector("#btRun", { timeout: 5000 });
    record("Open app and render SMA21 tester", "PASS", { url: BASE_URL });

    await page.locator("#btPair").selectOption("ZEC-USDT-SWAP");
    await page.locator("#btDays").selectOption("1");
    await page.locator("#btRun").click();
    const mainStatus = await waitForStatus(page, "Готово:", 240000);
    if (!mainStatus.startsWith("Готово: ZEC-USDT-SWAP")) {
      throw new Error(`Main historical test failed: ${mainStatus}`);
    }
    const mainMetrics = await page.locator("#btResults").innerText();
    if (!mainMetrics.includes("Свечей 1m") || !mainMetrics.includes("Свечей 15m для VP")) {
      throw new Error("Main test finished without expected 1m/15m candle metrics");
    }
    await page.screenshot({ path: path.join(OUT, "main-backtest.png"), fullPage: true });
    record("Run ZEC 1m backtest with 15m Volume Profile from live OKX API", "PASS", {
      message: mainStatus,
      metrics: mainMetrics.slice(0, 1600)
    });

    const comparisons = [
      { id: "btCompareEntry", label: "Entry comparison", success: "Сравнение входов завершено", resultId: "btCompareEntryResults" },
      { id: "btCompareExit", label: "Exit comparison", success: "Сравнение выходов завершено", resultId: "btCompareExitResults" },
      { id: "btCompareTrail", label: "5R vs ATR trailing comparison", success: "Сравнение 5R и ATR-трейлинга завершено", resultId: "btCompareTrailResults" },
      { id: "btComparePhase", label: "Market phase comparison", success: "Сравнение завершено на одном наборе", resultId: "btComparePhaseResults" },
      { id: "btCompareAdaptive", label: "Adaptive exit comparison", success: "Адаптивное сравнение завершено", resultId: "btCompareAdaptiveResults" },
      { id: "btCompare", label: "Volume Profile filter comparison", success: "Сравнение VP завершено", resultId: "btCompareResults" }
    ];

    for (const item of comparisons) {
      await page.locator("#" + item.id).scrollIntoViewIfNeeded();
      await page.locator("#" + item.id).click();
      const status = await waitForStatus(page, item.success, 240000);
      if (!status.includes(item.success)) {
        throw new Error(`${item.label} failed: ${status}`);
      }
      const resultText = (await page.locator("#" + item.resultId).innerText()).trim();
      if (!resultText) throw new Error(`${item.label} completed but produced no visible result`);
      record(item.label, "PASS", { message: status, resultPreview: resultText.slice(0, 900) });
    }

    if (pageErrors.length) {
      throw new Error("Browser JavaScript errors: " + pageErrors.join(" | "));
    }
    if (networkFailures.length) {
      throw new Error("Failed OKX API requests: " + JSON.stringify(networkFailures.slice(0, 8)));
    }
    record("No uncaught browser JavaScript errors or failed OKX requests", "PASS");
  } catch (error) {
    record("Browser run", "FAIL", { message: error.stack || String(error) });
    try { await page.screenshot({ path: path.join(OUT, "failure.png"), fullPage: true }); } catch {}
    throw error;
  } finally {
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({
      baseUrl: BASE_URL,
      timestamp: new Date().toISOString(),
      checks,
      pageErrors,
      networkFailures
    }, null, 2));
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
