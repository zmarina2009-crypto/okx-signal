import os
import time
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("PLAYWRIGHT_TEST_BASE_URL", "http://127.0.0.1:4173")


class BacktesterBrowserSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch()
        cls.context = cls.browser.new_context(viewport={"width": 1440, "height": 1000})
        cls.page = cls.context.new_page()
        cls.page_errors = []
        cls.page.on("pageerror", lambda error: cls.page_errors.append(str(error)))

    @classmethod
    def tearDownClass(cls):
        Path("test-results").mkdir(exist_ok=True)
        if hasattr(cls, "page"):
            try:
                cls.page.screenshot(path="test-results/backtester-final.png", full_page=True)
            except Exception:
                pass
        cls.context.close()
        cls.browser.close()
        cls.playwright.stop()

    def wait_for_action(self, button_id, timeout=240_000):
        button = self.page.locator(f"#{button_id}")
        button.click()
        button.wait_for(state="visible")
        self.page.wait_for_function(
            "(id) => { const b = document.getElementById(id); return b && !b.disabled; }",
            arg=button_id,
            timeout=timeout,
        )
        status = self.page.locator("#btStatus").inner_text()
        self.assertFalse(
            status.startswith("Ошибка"),
            f"{button_id} failed in browser: {status}",
        )
        self.assertTrue(status.strip(), f"{button_id} finished without a status message")

    def test_backtester_and_comparison_buttons_against_okx_history(self):
        self.page.goto(BASE_URL, wait_until="domcontentloaded", timeout=60_000)
        self.page.locator("#smaTester").wait_for(state="attached", timeout=30_000)

        # Keep this smoke run small and deterministic; it still requests live OKX history.
        self.page.locator("#btPair").select_option("ZEC-USDT-SWAP")
        self.page.locator("#btDays").select_option("1")
        self.assertEqual(self.page.locator("#btVpFilter").input_value(), "poc")
        self.assertEqual(self.page.locator("#btCapital").input_value(), "1000")

        self.wait_for_action("btRun")
        self.assertIn("Готово:", self.page.locator("#btStatus").inner_text())
        self.assertGreater(
            self.page.locator("#btResults .btmetric").count(), 5,
            "The main backtest should render its metrics.",
        )

        # Exercise all comparison flows so VP/risk parameters are actually consumed in-browser.
        for button_id in (
            "btCompareEntry",
            "btCompareExit",
            "btCompareTrail",
            "btComparePhase",
            "btCompareAdaptive",
            "btCompare",
        ):
            with self.subTest(button=button_id):
                self.wait_for_action(button_id)
                self.assertFalse(
                    self.page.locator("#btStatus").inner_text().startswith("Ошибка"),
                    f"Comparison failed: {button_id}",
                )

        # A browser runtime error is a hard failure; console warnings are recorded but tolerated.
        self.assertEqual(self.page_errors, [], f"Uncaught browser errors: {self.page_errors}")


if __name__ == "__main__":
    unittest.main()
