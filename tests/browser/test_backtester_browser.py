import json
import os
import re
import unittest
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("PLAYWRIGHT_TEST_BASE_URL", "http://127.0.0.1:4173")
OKX_HISTORY_URL = "https://www.okx.com/api/v5/market/history-candles"


class BacktesterBrowserSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()
        cls.context = cls.browser.new_context(viewport={"width": 1440, "height": 1000})
        cls.page = cls.context.new_page()
        cls.page_errors = []
        cls.okx_responses = []
        cls.period_comparison = ""
        cls.page.on("pageerror", lambda error: cls.page_errors.append(str(error)))

        def record_okx_response(response):
            if not response.url.startswith(OKX_HISTORY_URL):
                return
            parsed = urlparse(response.url)
            params = parse_qs(parsed.query)
            item = {
                "status": response.status,
                "bar": params.get("bar", [""])[0],
                "instId": params.get("instId", [""])[0],
                "count": 0,
                "code": None,
                "error": None,
            }
            try:
                payload = response.json()
                item["code"] = payload.get("code")
                item["count"] = len(payload.get("data") or [])
                item["error"] = payload.get("msg") if payload.get("code") != "0" else None
            except Exception as exc:
                item["error"] = str(exc)
            cls.okx_responses.append(item)

        cls.page.on("response", record_okx_response)

    @classmethod
    def tearDownClass(cls):
        Path("test-results").mkdir(exist_ok=True)
        if hasattr(cls, "page"):
            try:
                cls.page.screenshot(path="test-results/backtester-final.png", full_page=True)
            except Exception:
                pass
        Path("test-results").mkdir(exist_ok=True)
        Path("test-results/browser-report.json").write_text(
            json.dumps({
                "pageErrors": cls.page_errors,
                "okxResponses": cls.okx_responses,
                "periodComparison": cls.period_comparison,
            }, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        cls.context.close()
        cls.browser.close()
        cls.playwright.stop()

    def wait_for_action(self, button_id, expected_status, timeout=240_000):
        button = self.page.locator(f"#{button_id}")
        status_locator = self.page.locator("#btStatus")
        previous_status = status_locator.inner_text().strip()
        button.click()
        self.page.wait_for_function(
            """({id, previous, expected}) => {
                const button = document.getElementById(id);
                const status = (document.getElementById('btStatus')?.textContent || '').trim();
                return !!button && !button.disabled && status !== previous && status.includes(expected);
            }""",
            arg={"id": button_id, "previous": previous_status, "expected": expected_status},
            timeout=timeout,
        )
        status = status_locator.inner_text().strip()
        self.assertIn(expected_status, status, f"{button_id} did not finish successfully: {status}")
        self.assertFalse(status.startswith("Ошибка"), f"{button_id} failed in browser: {status}")
        return status

    def test_backtester_and_comparison_buttons_against_okx_history(self):
        response = self.page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
        self.assertIsNotNone(response, "App navigation returned no response")
        self.assertLess(response.status, 400, f"App page HTTP error: {response.status}")
        self.page.locator("#smaTester").wait_for(state="attached", timeout=30_000)

        self.page.locator("#btPair").select_option("ZEC-USDT-SWAP")
        self.page.locator("#btDays").select_option("1")
        self.assertEqual(self.page.locator("#btVpFilter").input_value(), "poc")
        self.assertEqual(self.page.locator("#btCapital").input_value(), "1000")

        main_status = self.wait_for_action("btRun", "Готово:")
        self.assertIn("ZEC-USDT-SWAP", main_status)
        self.assertRegex(main_status, r"\d+ (?:закрытых )?свечей 1m")
        self.assertRegex(main_status, r"\d+ (?:закрытых )?свечей 15m")
        self.assertGreater(
            self.page.locator("#btResults .btmetric").count(), 5,
            "The main backtest should render its metrics.",
        )
        main_text = self.page.locator("#btResults").inner_text()
        self.assertIn("Закрытых сделок", main_text)
        self.assertIn("VP-фильтр", main_text)

        comparisons = (
            ("btCompareEntry", "Сравнение входов завершено", "btCompareEntryResults"),
            ("btCompareExit", "Сравнение выходов завершено", "btCompareExitResults"),
            ("btCompareTrail", "Сравнение 5R и ATR-трейлинга завершено", "btCompareTrailResults"),
            ("btComparePhase", "Сравнение завершено на одном наборе", "btComparePhaseResults"),
            ("btCompareAdaptive", "Адаптивное сравнение завершено", "btCompareAdaptiveResults"),
            ("btCompare", "Сравнение VP завершено", "btCompareResults"),
        )
        for button_id, expected_status, result_id in comparisons:
            with self.subTest(button=button_id):
                status = self.wait_for_action(button_id, expected_status)
                self.assertRegex(status, r"(?:\d+ закрытых (?:минутных )?свеч|\d+ свечей 1m)")
                if button_id == "btCompare":
                    self.assertRegex(status, r"\d+ (?:закрытых )?свечей 15m")
                result = self.page.locator(f"#{result_id}")
                self.assertTrue(result.inner_text().strip(), f"{button_id} returned no visible comparison table")

        period_status = self.wait_for_action(
            "btComparePeriod",
            "Сравнение ZEC/NEAR за 7 и 14 дней завершено",
            timeout=480_000,
        )
        self.assertIn("четыре сценария", period_status)
        period_table = self.page.locator("#btComparePeriodResults table")
        self.assertTrue(period_table.is_visible(), "The 7d/14d comparison table should be visible")
        expected_cases = (
            "ZEC-USDT-SWAP-7",
            "ZEC-USDT-SWAP-14",
            "NEAR-USDT-SWAP-7",
            "NEAR-USDT-SWAP-14",
        )
        for case in expected_cases:
            row = self.page.locator(f'#btComparePeriodResults tr[data-case="{case}"]')
            self.assertEqual(row.count(), 1, f"Missing comparison row for {case}")
            self.assertGreater(len(row.locator("td").all()), 10, f"Incomplete result row for {case}")
        self.__class__.period_comparison = period_table.inner_text()
        print("\\nFOUR-WAY ZEC / NEAR 7D / 14D COMPARISON\\n" + self.period_comparison)

        self.assertEqual(self.page_errors, [], f"Uncaught browser errors: {self.page_errors}")
        successful_okx = [
            r for r in self.okx_responses
            if r["status"] == 200 and r["code"] == "0" and r["count"] > 0
            and r["instId"] == "ZEC-USDT-SWAP"
        ]
        self.assertTrue(any(r["bar"] == "1m" for r in successful_okx), "No successful live OKX 1m candle response was observed")
        self.assertTrue(any(r["bar"] == "15m" for r in successful_okx), "No successful live OKX 15m candle response was observed")
        for pair in ("ZEC-USDT-SWAP", "NEAR-USDT-SWAP"):
            pair_responses = [
                r for r in self.okx_responses
                if r["instId"] == pair and r["status"] == 200 and r["code"] == "0" and r["count"] > 0
            ]
            self.assertTrue(any(r["bar"] == "1m" for r in pair_responses), f"No successful {pair} 1m history response")
            self.assertTrue(any(r["bar"] == "15m" for r in pair_responses), f"No successful {pair} 15m history response")
        self.assertFalse(
            [r for r in self.okx_responses if r["instId"] in ("ZEC-USDT-SWAP", "NEAR-USDT-SWAP") and r["error"]],
            f"OKX history API errors: {self.okx_responses}",
        )


if __name__ == "__main__":
    unittest.main()
