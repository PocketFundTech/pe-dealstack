/**
 * Material Symbols, subset to the icons the product uses.
 *
 * The full variable font is ~4MB and blocked first paint on every cold load.
 * Google Fonts' `icon_names` parameter serves only the listed glyphs (~350KB)
 * with every axis intact, so icons look exactly the same.
 *
 * Using a new icon? Add its name here (keep the list alphabetical — Google
 * Fonts requires it). An icon missing from this list renders as its name in
 * plain text; iconFont.test.ts scans the source to catch that.
 */
export const ICON_NAMES = [
  "ac_unit", "account_balance", "account_balance_wallet", "account_tree", "add", "add_business",
  "add_circle", "add_task", "add_to_drive", "admin_panel_settings", "alternate_email", "analytics",
  "api", "arrow_back", "arrow_drop_down", "arrow_forward", "arrow_right", "arrow_upward",
  "article", "assignment", "assistant", "attach_file", "attachment", "auto_awesome",
  "auto_fix_high", "autorenew", "balance", "bar_chart", "block", "bolt", "book", "browse", "build",
  "business", "business_center", "cached", "calculate", "calendar_month", "calendar_today", "call",
  "campaign", "cancel", "candlestick_chart", "category", "celebration", "center_focus_strong",
  "center_focus_weak", "chat", "chat_bubble", "check", "check_circle", "check_small", "checklist",
  "chevron_left", "chevron_right", "circle", "class", "close", "cloud", "cloud_circle",
  "cloud_done", "cloud_off", "cloud_queue", "cloud_upload", "code", "comment", "compare",
  "compare_arrows", "compress", "construction", "contact_mail", "contacts", "content_copy",
  "corporate_fare", "create", "create_new_folder", "csv", "dark_mode", "dashboard", "date_range",
  "delete", "delete_sweep", "density_large", "density_medium", "density_small", "description",
  "details", "devices", "diversity_3", "do_not_disturb_on", "docs", "domain", "done", "done_all",
  "donut_large", "download", "draft", "drafts", "drag_indicator", "draw", "edit", "edit_document",
  "edit_note", "email", "energy", "engineering", "enhanced_encryption", "enterprise", "error",
  "error_outline", "event", "event_available", "event_busy", "event_note", "event_upcoming",
  "expand", "expand_less", "expand_more", "extension", "fact_check", "factory", "feed",
  "file_download", "file_present", "files", "filter_alt", "filter_alt_off", "filter_list", "flag",
  "folder", "folder_open", "format_clear", "format_list_bulleted", "forum", "forward_to_inbox",
  "function", "gavel", "gpp_maybe", "grading", "graphic_eq", "grid_view", "group", "group_add",
  "groups", "handshake", "hard_drive", "hd", "height", "help", "history", "home_work",
  "hourglass_top", "how_to_reg", "html", "http", "https", "hub", "image", "inbox", "info", "input",
  "insert_chart", "insights", "inventory", "inventory_2", "ios_share", "iso", "key",
  "keyboard_arrow_down", "keyboard_arrow_up", "label", "language", "leaderboard", "light",
  "light_mode", "lightbulb", "link", "link_off", "list", "list_alt", "local_fire_department",
  "local_shipping", "lock", "lock_clock", "lock_person", "lock_reset", "login", "logout", "mail",
  "mail_lock", "manage_accounts", "margin", "mark_email_read", "memory", "menu", "menu_book",
  "merge_type", "message", "mic", "mobile", "mode", "money_off", "monitor_heart", "monitoring",
  "more", "more_horiz", "more_vert", "move", "move_to_inbox", "news", "not_interested", "note",
  "notes", "notifications", "notifications_active", "notifications_off", "open_in_full",
  "open_in_new", "outbound", "outgoing_mail", "overview", "paid", "palette", "password", "pattern",
  "payments", "pending", "people", "percent", "person", "person_add", "person_off", "phone",
  "photo_camera", "picture_as_pdf", "pie_chart", "play_arrow", "playlist_remove", "policy", "poll",
  "portrait", "post", "precision_manufacturing", "preview", "priority", "priority_high", "privacy",
  "productivity", "progress_activity", "psychology", "public", "query_stats", "radar", "radio",
  "radio_button_unchecked", "rate_review", "receipt_long", "recommend", "record_voice_over",
  "refresh", "reminder", "remove", "remove_circle", "reply", "report", "restart_alt", "restaurant",
  "rocket_launch", "room", "route", "rss_feed", "rule", "save", "scale", "schedule", "schema",
  "school", "science", "score", "script", "search", "search_off", "security", "send", "serif",
  "settings", "shadow", "share", "shield", "shield_lock", "shield_with_heart", "shopping_bag",
  "shopping_cart", "signature", "skeleton", "slideshow", "smart_toy", "snooze", "sort", "source",
  "south_east", "speed", "square", "star", "start", "step", "steps", "sticky_note_2", "store",
  "storefront", "stream", "style", "subject", "summarize", "sunny", "support", "swap_horiz",
  "swap_vert", "switch", "swords", "sync", "tab", "table", "table_chart", "table_view", "tag",
  "target", "task", "task_alt", "terminal", "thumb_up", "timeline", "tips_and_updates", "title",
  "today", "token", "topic", "transform", "travel_explore", "trending_down", "trending_flat",
  "trending_up", "tune", "upcoming", "update", "upload", "upload_file", "verified",
  "verified_user", "view_column", "view_in_ar", "view_kanban", "view_list", "visibility",
  "visibility_off", "vpn_key", "warning", "water_drop", "web", "webhook", "widgets", "width",
  "work", "workflow", "workspaces",
] as const;

export const ICON_FONT_URL =
  "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" +
  `&icon_names=${ICON_NAMES.join(",")}&display=block`;
