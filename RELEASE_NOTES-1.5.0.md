Brittain Code 1.5.0 adds cloud provider support, durable background chats, and more PDF tools.

Changes since 1.4.6:

- Use an OpenAI-compatible cloud endpoint or a local Ollama endpoint. Provider settings include the endpoint and API key status.
- See cloud token costs from provider model prices. New cost records persist when you reopen a chat or restart the app.
- Continue chat runs while you view another conversation. Saved chats retain their title state, context, and online settings.
- Read scanned PDFs and PDFs with unreadable text layers by rendering their pages. Use PDF tools to inspect and edit attached documents.
- Use a local calculator in Chat mode and retain Chat memory between conversations.
- Continue Discord conversations after a restart. Queue handling, event routing, stop controls, and daemon controls have fixes.
- Keep large tool results within the context budget and retain the task during conversation compaction.

Release fixes:

- Generate chat titles after completed runs, including background runs. Failed title requests have a bounded retry count.
- Open web links in the system browser. Block remote page access to app commands and block remote images in chat output.
- Save chat files through a temporary file and atomic replacement. Recover the history list from valid chat files if its index is damaged.
- Build macOS ARM64, macOS Intel, and Windows x64 packages on matching runners. Check native binaries and render a PDF from the packaged files before release.
- Update Electron to 43.6.0, Electron Builder to 26.15.3, and DOMPurify to 3.4.15.

Installation notes:

- Choose the macOS download that matches your processor, or the Windows x64 installer.
- macOS packages use an ad-hoc signature. macOS updates remain manual. Windows release builds support automatic updates.
- Local models require a running Ollama-compatible service. Cloud models require a configured endpoint and credentials.
- Existing chats without saved cost records cannot recover their earlier spend totals. Cost tracking continues from new requests.
- Online research remains a separate setting from the choice of inference provider.
