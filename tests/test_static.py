"""Offline checks for the deployable source and public templates."""

from pathlib import Path
import py_compile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class StaticChecks(unittest.TestCase):
    def test_python_sources_compile(self) -> None:
        for source in (ROOT / "src").glob("*.py"):
            py_compile.compile(str(source), doraise=True)

    def test_fresh_codex_session_does_not_abort_bridge_startup(self) -> None:
        source = (ROOT / "src" / "codex_repl_bridge.py").read_text()
        self.assertIn("startup waiting for Codex session JSONL", source)
        self.assertIn("it will bind after the first TUI turn", source)
        self.assertIn("waiting for Codex session JSONL; retrying in background", source)
        self.assertIn("next_session_wait_log = now + 30", source)

    def test_config_template_has_no_values_for_secrets(self) -> None:
        text = (ROOT / "deploy" / "telegram-agent-bridge.env.example").read_text()
        self.assertIn("TAB_BOT_TOKEN=\n", text)
        self.assertIn("TAB_CHAT_ID=\n", text)

    def test_service_name_is_consistent(self) -> None:
        script = (ROOT / "scripts" / "install.sh").read_text()
        self.assertIn("telegram-agent-bridge.service", script)

    def test_macos_launch_agent_is_installed(self) -> None:
        script = (ROOT / "scripts" / "install.sh").read_text()
        template = (ROOT / "deploy" / "com.codex-telegram-bridge.codex.plist.template").read_text()
        self.assertIn("Darwin", script)
        self.assertIn("launchctl bootstrap", script)
        self.assertIn("SERVICE_PATH=", script)
        self.assertIn("export PATH=\"$SERVICE_PATH\"", script)
        self.assertIn("com.codex-telegram-bridge.codex", template)
