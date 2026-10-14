//! Native macOS menu bar: app menu (About/Hide/Quit), Edit (so copy and paste
//! reach the web view), View, Window and Help.

use std::sync::Arc;

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuEvent, MenuItemBuilder, SubmenuBuilder, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Manager, Wry};

use crate::backend::Backend;
use crate::{system, MAIN_WINDOW};

const RESTART: &str = "restart-app";
const RELOAD: &str = "reload-window";
const SHOW_LOG: &str = "show-backend-log";
const OPEN_DATA: &str = "open-data-folder";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let package = app.package_info();
    let about = AboutMetadataBuilder::new()
        .name(Some(package.name.clone()))
        .version(Some(package.version.to_string()))
        .copyright(app.config().bundle.copyright.clone())
        .build();

    let app_menu = SubmenuBuilder::new(app, &package.name)
        .about(Some(about))
        .separator()
        .item(&MenuItemBuilder::with_id(RESTART, "Restart iPhone AI").build(app)?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu =
        SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id(RELOAD, "Reload").accelerator("CmdOrCtrl+R").build(app)?)
        .separator()
        .fullscreen()
        .build()?;

    let window_menu = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .separator()
        .bring_all_to_front()
        .build()?;

    let help_menu = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
        .item(&MenuItemBuilder::with_id(SHOW_LOG, "Show Backend Log in Finder").build(app)?)
        .item(&MenuItemBuilder::with_id(OPEN_DATA, "Open Data Folder").build(app)?)
        .build()?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        // Relaunch through LaunchServices; RunEvent::Exit stops the backend first.
        // Useful after granting Screen Recording, which needs an app restart.
        RESTART => app.request_restart(),
        RELOAD => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.reload();
            }
        }
        SHOW_LOG => {
            if let Some(backend) = app.try_state::<Arc<Backend>>() {
                system::reveal_in_finder(backend.log_file());
            }
        }
        OPEN_DATA => {
            if let Some(backend) = app.try_state::<Arc<Backend>>() {
                system::open_path(backend.data_dir());
            }
        }
        _ => {}
    }
}
