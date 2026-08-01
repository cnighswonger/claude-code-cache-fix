/*
 * claude-vscode-wrapper.c — Native wrapper for Claude Code + cache-fix on VS Code (Windows)
 *
 * The VS Code Claude extension uses child_process.spawn() without shell: true,
 * so .bat/.cmd wrappers fail with EINVAL. This native exe sets NODE_OPTIONS
 * and spawns node cli.js with the interceptor loaded.
 *
 * Compile: cl claude-vscode-wrapper.c /Fe:claude-vscode-wrapper.exe
 *     or:  gcc -o claude-vscode-wrapper.exe claude-vscode-wrapper.c
 *
 * Usage in VS Code settings.json:
 *   { "claudeCode.claudeProcessWrapper": "C:\\path\\to\\claude-vscode-wrapper.exe" }
 *
 * Credit: @JEONG-JIWOO (original implementation, #16)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <process.h>
#include <windows.h>

int main(int argc, char *argv[]) {
    char *appdata = getenv("APPDATA");
    if (!appdata) {
        fprintf(stderr, "APPDATA not set\n");
        return 1;
    }

    /* Build the preload path with forward slashes for file:// URL */
    char preload[MAX_PATH];
    snprintf(preload, sizeof(preload),
        "%s\\npm\\node_modules\\claude-code-cache-fix\\preload.mjs", appdata);

    char preload_url[MAX_PATH];
    snprintf(preload_url, sizeof(preload_url), "%s", preload);
    for (char *p = preload_url; *p; p++) {
        if (*p == '\\') *p = '/';
    }

    /* URL-encode spaces for NODE_OPTIONS parsing */
    char encoded_url[MAX_PATH * 3];
    char *dst = encoded_url;
    for (const char *src = preload_url; *src && dst < encoded_url + sizeof(encoded_url) - 4; src++) {
        if (*src == ' ') {
            *dst++ = '%'; *dst++ = '2'; *dst++ = '0';
        } else {
            *dst++ = *src;
        }
    }
    *dst = '\0';

    char node_opts[MAX_PATH * 4];
    snprintf(node_opts, sizeof(node_opts),
        "NODE_OPTIONS=--import file:///%s", encoded_url);
    _putenv(node_opts);

    /* Path to Claude Code CLI */
    char cli_path[MAX_PATH];
    snprintf(cli_path, sizeof(cli_path),
        "%s\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js", appdata);

    /* Build argv: skip argv[1] (original claude path passed by extension) */
    char **new_argv = calloc((size_t)argc + 2, sizeof(char *));
    if (!new_argv) return 1;

    new_argv[0] = "node";
    new_argv[1] = cli_path;
    int j = 2;
    for (int i = 2; i < argc; i++) {
        new_argv[j++] = argv[i];
    }
    new_argv[j] = NULL;

    return _spawnvp(_P_WAIT, "node", (const char *const *)new_argv);
}
