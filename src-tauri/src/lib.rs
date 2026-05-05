mod commands;
mod extract;
mod llm;
mod retrieve;
mod schema;
mod sidecar;
mod store;

use sidecar::SidecarManager;
use store::Store;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().data_dir()?;
            let db_path = data_dir.join("sql-mate").join("store.db");
            let store = Store::open(&db_path)?;
            app.manage(store);

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
            commands::delete_provider_config,
            commands::set_active_provider,
            commands::get_active_provider,
            commands::get_model_registry,
            commands::generate_sql,
            commands::validate_sql,
            commands::execute_query,
            commands::list_history,
            commands::clear_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
