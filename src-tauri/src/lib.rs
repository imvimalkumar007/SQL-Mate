mod extract;
mod llm;
mod schema;
mod store;

use store::Store;
use tauri::Manager;

const STUB_SCHEMA: &str = "schema: public
  customers
    id: integer [PK] [NOT NULL]
    email: varchar [NOT NULL]
    created_at: timestamp [NOT NULL]
  orders
    id: integer [PK] [NOT NULL]
    customer_id: integer [NOT NULL] [FK -> public.customers.id]
    total_cents: integer [NOT NULL]
    placed_at: timestamp [NOT NULL]";

const STUB_QUESTION: &str = "How many orders did each customer place last month?";

#[tauri::command]
async fn generate_sql(api_key: String) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("API key is empty.".to_string());
    }
    llm::anthropic::call_anthropic(&api_key, STUB_SCHEMA, STUB_QUESTION)
        .await
        .map_err(|e| e.to_string())
}

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
        .invoke_handler(tauri::generate_handler![generate_sql])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
