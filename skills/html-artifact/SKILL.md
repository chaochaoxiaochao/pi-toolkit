---
name: html-artifact
description: Create self-contained, responsive HTML artifacts for complex explanations that benefit from visual structure or interaction, including workflows, code/module relationships, state machines, event/data flows, architecture maps, timelines, comparisons, dashboards, and interactive demonstrations.
---

# HTML Artifact

## Decide the format

Use Markdown when the response is short, linear, text-first, or primarily a focused code review. Use an HTML artifact when visual layout, filtering, expanding details, tabs, highlighting, diagrams, timelines, or interactive state changes materially improve understanding.

Do not create HTML merely to wrap a small answer. The artifact should reduce cognitive load and make the subject easier to inspect.

## Create the artifact

1. Read the relevant code and verify names, relationships, and behavior before visualizing them.
2. Follow the project's existing output convention. If none exists, write to `.cache/html/<descriptive-name>.html`.
3. Prefer one self-contained HTML file with inline CSS and JavaScript so it can be opened or previewed without a build step.
4. Use semantic HTML, responsive layout, keyboard-accessible controls, visible focus states, and stable dimensions for interactive elements.
5. Use restrained styling suited to the domain. Keep diagrams and panels scannable; do not hide important information behind interaction.
6. Escape source code before placing it in `<pre><code>` blocks. Do not alter code identifiers, paths, or quoted source text for presentation.
7. Add only interactions that answer a real viewing need: tabs, expand/collapse, search/filter, step-through state, highlighting, or a reset control.
8. Keep external dependencies out unless the project already uses them. If a library is necessary, document the dependency and provide a usable fallback when practical.

## Verify and report

After writing the file, verify that it exists and contains a complete document. If a preview or dev-server tool is available, start it and check the returned health status before reporting success. Use the preview URL returned by that tool; never present `localhost` as a user-facing online URL when the environment uses a reverse proxy.

Respond with a concise Markdown summary and a clickable file path or verified preview URL. Mention any limitation, such as a preview service not being available. Do not paste the entire HTML into the chat unless the user explicitly asks for it.
