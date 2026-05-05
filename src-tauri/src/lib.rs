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

use request_log::RequestLog;
use sidecar::SidecarManager;
use store::Store;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const WIDGET_HOTKEY: &str = "CommandOrControl+Shift+Space";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::SHIFT | Modifiers::CONTROL, Code::Space)
                    {
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

            // Register the global hotkey. If unavailable, we surface the error
            // in stderr but otherwise continue — the user can still summon the
            // widget via the tray icon.
            if let Err(e) = app
                .global_shortcut()
                .register(Shortcut::new(
                    Some(Modifiers::SHIFT | Modifiers::CONTROL),
                    Code::Space,
                ))
            {
                eprintln!(
                    "global hotkey {WIDGET_HOTKEY} could not be registered: {e}. \
                     Use the tray icon to summon the widget."
                );
            }

            // Hide the widget when the user clicks elsewhere — matches the
            // raycast/spotlight pattern.
            if let Some(widget) = app.get_webview_window("widget") {
                let handle = app.handle().clone();
                widget.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        if let Some(w) = handle.get_webview_window("widget") {
                            let _ = w.hide();
                        }
                    }
                });
            }

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn show_widget_window(app: &AppHandle) {
    if let Some(widget) = app.get_webview_window("widget") {
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
