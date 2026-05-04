mod commands;
mod extract;
mod llm;
mod schema;
mod store;

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_connection_profile,
            commands::list_connection_profiles,
            commands::delete_connection_profile,
            commands::test_connection,
            commands::extract_schema,
            commands::get_persisted_schema,
            commands::save_api_key,
            commands::delete_api_key,
            commands::has_api_key,
            commands::generate_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
