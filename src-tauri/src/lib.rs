mod commands;
mod extract;
mod llm;
mod redact;
mod request_log;
mod retrieve;
mod schema;
mod security_pdf;
mod sidecar;
mod store;

use std::str::FromStr;

use request_log::RequestLog;
use sidecar::SidecarManager;
use store::Store;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub const DEFAULT_WIDGET_HOTKEY: &str = "CommandOrControl+Shift+Space";
pub const SETTING_WIDGET_HOTKEY: &str = "widget_hotkey";
pub const SETTING_WIDGET_HOTKEY_ERROR: &str = "widget_hotkey_error";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Phase 11: auto-start on Windows boot. Disabled by default; user
        // opts in via Settings → Widget. Plugin manages the OS-level
        // registry entry; our `get/set_autostart_enabled` commands proxy
        // through.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Match by triggered event rather than by hotkey
                    // identity — the hotkey may have been re-registered
                    // since startup, but only one global shortcut is ever
                    // active at a time so any press is the widget summon.
                    if event.state == ShortcutState::Pressed {
                        toggle_widget_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let data_dir = app.path().data_dir()?;
            let db_path = data_dir.join("sql-mate").join("store.db");
            let store = Store::open(&db_path)?;
            app.manage(store);
            app.manage(RequestLog::new());

            // Tray icon — left-click toggles the widget, right-click opens the menu.
            let show_widget_item =
                MenuItem::with_id(app, "show_widget", "Show widget", true, None::<&str>)?;
            let open_main_item =
                MenuItem::with_id(app, "open_main", "Open main window", true, None::<&str>)?;
            let separator =
                tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_widget_item, &open_main_item, &separator, &quit_item],
            )?;

            let _tray = TrayIconBuilder::with_id("sql-mate-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("SQL Mate")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show_widget" => show_widget_window(app),
                    "open_main" => show_main_window_internal(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_widget_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Phase 11: load the hotkey from settings (or use the default),
            // register it, and persist any error to settings so the
            // main-window settings UI can surface it.
            let store_state: tauri::State<Store> = app.state();
            let configured_hotkey = read_setting(&store_state, SETTING_WIDGET_HOTKEY)
                .unwrap_or_else(|| DEFAULT_WIDGET_HOTKEY.to_string());
            match register_hotkey(app.handle(), &configured_hotkey) {
                Ok(()) => {
                    let _ = clear_setting(&store_state, SETTING_WIDGET_HOTKEY_ERROR);
                }
                Err(e) => {
                    eprintln!(
                        "global hotkey {configured_hotkey} could not be registered: {e}. \
                         Use the tray icon to summon the widget; rebind in Settings → Widget."
                    );
                    let _ = write_setting(&store_state, SETTING_WIDGET_HOTKEY_ERROR, &e);
                }
            }

            // Note: Phase 11 user feedback removed the auto-hide-on-focus-loss
            // behavior. Starting a drag on Windows briefly transfers focus
            // to the OS window manager, which fired the handler before the
            // user could complete the drag — the widget vanished mid-grab.
            // The widget now stays visible until explicitly dismissed (Esc,
            // the close button, or clicking the tray icon).

            // Spawn the Python sidecar. If startup fails (Python missing,
            // sqlglot not installed, handshake timeout), we surface the
            // error and refuse to launch — validation is load-bearing per
            // SECURITY_MODEL.md, so an app without a working validator is
            // not safe to use.
            let handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                match SidecarManager::spawn().await {
                    Ok(mgr) => {
                        handle.manage(mgr);
                        Ok(())
                    }
                    Err(e) => Err(Box::<dyn std::error::Error>::from(e.to_string())),
                }
            })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_connection_profile,
            commands::list_connection_profiles,
            commands::delete_connection_profile,
            commands::test_connection,
            commands::extract_schema,
            commands::get_persisted_schema,
            commands::embed_schema,
            commands::clear_schema_embeddings,
            commands::get_embedding_stats,
            commands::list_provider_configs,
            commands::create_provider_config,
            commands::update_provider_model,
            commands::delete_provider_config,
            commands::set_active_provider,
            commands::get_active_provider,
            commands::get_model_registry,
            commands::generate_sql,
            commands::validate_sql,
            commands::list_history,
            commands::clear_history,
            commands::set_annotation,
            commands::clear_annotation,
            commands::list_annotations,
            commands::set_redaction,
            commands::clear_redaction,
            commands::list_redactions,
            commands::get_last_request_log,
            commands::get_telemetry_enabled,
            commands::set_telemetry_enabled,
            commands::get_onboarding_completed,
            commands::mark_onboarding_completed,
            commands::export_security_pdf,
            commands::get_widget_state,
            commands::set_widget_position,
            commands::set_widget_pill_mode,
            commands::set_widget_last_query,
            commands::clear_widget_last_query,
            commands::show_widget,
            commands::hide_widget,
            commands::show_main_window,
            commands::get_widget_hotkey,
            commands::set_widget_hotkey,
            commands::get_widget_hotkey_error,
            commands::get_autostart_enabled,
            commands::set_autostart_enabled,
            commands::clamp_widget_to_visible_monitor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_widget_window(app: &AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        commands::ensure_widget_on_visible_monitor(&widget);
        let _ = widget.show();
        let _ = widget.set_focus();
        let _ = app.emit_to("widget", "widget://focus", ());
    }
}

fn toggle_widget_window(app: &AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
        let visible = widget.is_visible().unwrap_or(false);
        if visible {
            let _ = widget.hide();
        } else {
            commands::ensure_widget_on_visible_monitor(&widget);
            let _ = widget.show();
            let _ = widget.set_focus();
            let _ = app.emit_to("widget", "widget://focus", ());
        }
    }
}

fn show_main_window_internal(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// Parse a hotkey string and register it as the global shortcut. Unregisters
/// any previously-active shortcut first so re-binding always replaces.
pub fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let parsed = Shortcut::from_str(hotkey).map_err(|e| format!("invalid hotkey: {e}"))?;
    gs.register(parsed).map_err(|e| e.to_string())
}

// ---------- helper: synchronous settings access (used at startup) ----------

fn read_setting(store: &Store, key: &str) -> Option<String> {
    let conn = store.lock();
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn write_setting(store: &Store, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    let conn = store.lock();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map(|_| ())
}

fn clear_setting(store: &Store, key: &str) -> Result<(), rusqlite::Error> {
    let conn = store.lock();
    conn.execute(
        "DELETE FROM settings WHERE key = ?1",
        rusqlite::params![key],
    )
    .map(|_| ())
}
