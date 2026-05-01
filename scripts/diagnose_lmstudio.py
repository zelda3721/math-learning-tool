#!/usr/bin/env python3
"""
Diagnose LMStudio (or any OpenAI-compatible) chat/completions failures.

Builds the exact payload the harness AgentLoop sends — full system prompt,
all 6 tool definitions, the user's grade — then POSTs via raw httpx so the
upstream error body is visible. The openai SDK turns server errors into
`Error code: 502` and discards the body; this script does not.

Usage:
    python scripts/diagnose_lmstudio.py
    python scripts/diagnose_lmstudio.py --no-tools    # send without tools
    python scripts/diagnose_lmstudio.py --stream      # use streaming
    python scripts/diagnose_lmstudio.py --tool analyze_problem   # single tool
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))

import httpx  # type: ignore  # comes with openai sdk
from math_tutor.config.settings import get_settings
from math_tutor.infrastructure.llm.openai_provider import _is_local_url
from math_tutor.infrastructure.agent import LearnedMemory, PromptComposer
from math_tutor.infrastructure.agent.tools import build_default_registry
from math_tutor.infrastructure.llm import OpenAILLMProvider
from math_tutor.infrastructure.manim import ManimExecutor
from math_tutor.infrastructure.skills import FileSkillRepository
from math_tutor.infrastructure.storage import Database, ExamplesStore


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Diagnose LMStudio chat/completions failures")
    p.add_argument("--problem", default="鸡兔同笼，头35脚94", help="user message")
    p.add_argument("--grade", default="elementary_upper")
    p.add_argument("--no-tools", action="store_true", help="omit the tools field")
    p.add_argument("--tool", action="append", default=[], help="restrict to listed tool names; repeatable")
    p.add_argument("--stream", action="store_true", help="set stream=true")
    p.add_argument(
        "--enable-thinking",
        action="store_true",
        help="explicitly turn thinking ON (default: off when tools are sent)",
    )
    p.add_argument("--max-tokens", type=int, default=None)
    p.add_argument("--no-auth", action="store_true", help="omit the Authorization header")
    p.add_argument(
        "--no-template-kwargs",
        action="store_true",
        help="omit the top-level chat_template_kwargs field (LMStudio may choke on it)",
    )
    p.add_argument("--no-system", action="store_true", help="omit the system prompt entirely")
    p.add_argument("--simple-system", action="store_true", help="use a 1-line system prompt instead of the full one")
    p.add_argument("--dump-body", metavar="PATH", help="write the request JSON body to this file and exit before sending")
    p.add_argument("--print-curl", action="store_true", help="print an equivalent curl command at the end")
    return p.parse_args()


async def main() -> int:
    args = parse_args()
    settings = get_settings()

    skills_dir = ROOT / "backend" / "src" / "math_tutor" / "infrastructure" / "skills" / "definitions"
    llm = OpenAILLMProvider(
        base_url=settings.llm_api_base,
        api_key=settings.llm_api_key,
        default_model=settings.llm_model,
    )
    skill_repo = FileSkillRepository(skills_dir)
    db = Database(settings.resolved_db_path)
    examples = ExamplesStore(db)
    learned = LearnedMemory(settings.resolved_data_dir)
    video_gen = ManimExecutor(
        output_dir=settings.manim_output_dir, quality=settings.manim_quality
    )

    registry = build_default_registry(
        llm=llm,
        skill_repo=skill_repo,
        examples_store=examples,
        video_generator=video_gen,
        use_latex=settings.manim_use_latex,
        learned_memory=learned,
    )
    all_tools = [t.to_openai_format() for t in registry.list_definitions()]
    if args.tool:
        wanted = set(args.tool)
        all_tools = [t for t in all_tools if t["function"]["name"] in wanted]

    composer = PromptComposer()
    if args.no_system:
        system_prompt = ""
    elif args.simple_system:
        system_prompt = "你是数学辅导助手。"
    else:
        system_prompt = composer.compose(
            grade=args.grade,
            use_latex=settings.manim_use_latex,
            learned_context=learned.read(),
        )

    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": args.problem})

    body: dict = {
        "model": settings.llm_model,
        "messages": messages,
        "max_tokens": args.max_tokens or settings.llm_max_tokens,
        "temperature": settings.llm_temperature,
        "stream": bool(args.stream),
    }
    if not args.no_tools and all_tools:
        body["tools"] = all_tools
        body["tool_choice"] = "auto"

    if not args.no_template_kwargs:
        extra = settings.llm_extra_body_dict
        ctk = dict(extra.get("chat_template_kwargs") or {})
        if not args.enable_thinking and "tools" in body:
            ctk["enable_thinking"] = False
        elif args.enable_thinking:
            ctk["enable_thinking"] = True
        if ctk:
            body["chat_template_kwargs"] = ctk
        for k, v in extra.items():
            if k != "chat_template_kwargs":
                body[k] = v

    print(f"=== Endpoint ===")
    print(f"  base_url: {settings.llm_api_base}")
    print(f"  model:    {settings.llm_model}")
    print()
    print(f"=== Request ===")
    print(f"  system_prompt: {len(system_prompt)} chars")
    print(f"  user message:  {args.problem!r}")
    print(f"  stream:        {body['stream']}")
    print(f"  max_tokens:    {body['max_tokens']}")
    print(f"  temperature:   {body['temperature']}")
    if "tools" in body:
        print(f"  tools:         {len(body['tools'])}")
        for t in body["tools"]:
            sz = len(json.dumps(t, ensure_ascii=False))
            print(f"    - {t['function']['name']:25s} {sz:5d}B")
    else:
        print(f"  tools:         (omitted)")
    if "chat_template_kwargs" in body:
        print(f"  chat_template_kwargs: {body['chat_template_kwargs']}")
    body_text = json.dumps(body, ensure_ascii=False)
    print(f"  total body:    {len(body_text)} chars")
    print()

    url = f"{settings.llm_api_base.rstrip('/')}/chat/completions"

    if args.dump_body:
        Path(args.dump_body).write_text(body_text, encoding="utf-8")
        print(f"=== Body written to {args.dump_body} (skipping POST) ===")
        if args.print_curl:
            _print_curl(url, settings.llm_api_key, args.no_auth, body["stream"], args.dump_body)
        return 0

    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if body["stream"] else "application/json",
    }
    if not args.no_auth:
        headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    print(f"=== POST {url} ===")
    print(f"  headers sent: {list(headers.keys())}")

    # Bypass any system HTTP_PROXY for localhost — same logic the provider
    # applies in production. Corporate proxies often intercept localhost and
    # return 502 with empty body.
    client_kwargs: dict[str, Any] = {"timeout": settings.llm_request_timeout}
    if _is_local_url(url):
        client_kwargs["trust_env"] = False
        client_kwargs["mounts"] = {
            "http://": httpx.AsyncHTTPTransport(),
            "https://": httpx.AsyncHTTPTransport(),
        }
        print("  (bypassing system proxy: base_url is local)")

    async with httpx.AsyncClient(**client_kwargs) as client:
        try:
            response = await client.post(
                url,
                headers=headers,
                content=body_text.encode("utf-8"),
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  TRANSPORT ERROR: {type(exc).__name__}: {exc}")
            return 2

    print(f"  status:  {response.status_code} {response.reason_phrase}")
    print(f"  headers: {dict(response.headers)}")
    print(f"  --- body (first 4000 chars) ---")
    print(response.text[:4000] or "<empty>")

    if args.print_curl:
        # Save body to a temp file for easy curl replay
        tmp = Path("/tmp/diagnose_lmstudio_body.json")
        tmp.write_text(body_text, encoding="utf-8")
        _print_curl(url, settings.llm_api_key, args.no_auth, body["stream"], str(tmp))

    return 0 if response.status_code < 400 else 1


def _print_curl(url: str, key: str, no_auth: bool, stream: bool, body_path: str) -> None:
    pieces = [
        "\n=== Equivalent curl ===",
        "curl -v",
    ]
    if stream:
        pieces.append("  -N")
    pieces.append("  -X POST")
    pieces.append(f"  '{url}'")
    pieces.append("  -H 'Content-Type: application/json'")
    if not no_auth:
        pieces.append(f"  -H 'Authorization: Bearer {key}'")
    pieces.append(f"  --data-binary @{body_path}")
    print(" \\\n".join(pieces))


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
