#include <gtk/gtk.h>

/* Widget constructors */
static inline GtkWidget *shim_box_new(int horizontal, int spacing) { return gtk_box_new(horizontal ? GTK_ORIENTATION_HORIZONTAL : GTK_ORIENTATION_VERTICAL, spacing); }
static inline void shim_box_append(GtkWidget *box, GtkWidget *child) { gtk_box_append(GTK_BOX(box), child); }
static inline GtkWidget *shim_label(const char *text) { return gtk_label_new(text); }
static inline GtkWidget *shim_button(const char *text) { return gtk_button_new_with_label(text); }
static inline GtkWidget *shim_scrolled_window(void) { return gtk_scrolled_window_new(); }
static inline void shim_scrolled_set_child(GtkWidget *scroll, GtkWidget *child) { gtk_scrolled_window_set_child(GTK_SCROLLED_WINDOW(scroll), child); }
static inline GtkWidget *shim_text_view(void) { return gtk_text_view_new(); }
static inline void shim_text_view_setup(GtkWidget *tv) {
    gtk_text_view_set_editable(GTK_TEXT_VIEW(tv), 0);
    gtk_text_view_set_cursor_visible(GTK_TEXT_VIEW(tv), 0);
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(tv), GTK_WRAP_WORD_CHAR);
}
static inline GtkTextBuffer *shim_text_buffer(GtkWidget *tv) { return gtk_text_view_get_buffer(GTK_TEXT_VIEW(tv)); }
static inline void shim_text_append(GtkTextBuffer *buf, const char *text) {
    GtkTextIter end;
    gtk_text_buffer_get_end_iter(buf, &end);
    gtk_text_buffer_insert(buf, &end, text, -1);
}
static inline void shim_text_append_code(GtkTextBuffer *buf, const char *text, GtkTextTag *tag) {
    GtkTextIter end;
    gtk_text_buffer_get_end_iter(buf, &end);
    gint line = gtk_text_iter_get_line(&end);
    gtk_text_buffer_insert(buf, &end, text, -1);
    GtkTextIter start;
    gtk_text_buffer_get_iter_at_line(buf, &start, line);
    GtkTextIter newEnd;
    gtk_text_buffer_get_end_iter(buf, &newEnd);
    gtk_text_buffer_apply_tag(buf, tag, &start, &newEnd);
}
static inline GtkTextTag *shim_code_tag(GtkTextBuffer *buf) { return gtk_text_buffer_create_tag(buf, "code", "family", "monospace", "background", "#2A273F", NULL); }
static inline GtkWidget *shim_entry(void) { return gtk_entry_new(); }
static inline void shim_entry_set_text(GtkWidget *entry, const char *text) { gtk_entry_buffer_set_text(gtk_entry_get_buffer(GTK_ENTRY(entry)), text, -1); }
static inline void shim_css_class(GtkWidget *w, const char *name) { gtk_widget_add_css_class(w, name); }
static inline void shim_widget_size(GtkWidget *w, int width) { gtk_widget_set_size_request(w, width, -1); }
static inline void shim_widget_expand(GtkWidget *w, int horizontal) { if (horizontal) gtk_widget_set_hexpand(w, 1); else gtk_widget_set_vexpand(w, 1); }
static inline void shim_widget_halign_start(GtkWidget *w) { gtk_widget_set_halign(w, GTK_ALIGN_START); }
static inline void shim_window(GtkWidget *win, const char *title, int width, int height) {
    gtk_window_set_title(GTK_WINDOW(win), title);
    gtk_window_set_default_size(GTK_WINDOW(win), width, height);
}
static inline void shim_window_set_child(GtkWidget *win, GtkWidget *child) { gtk_window_set_child(GTK_WINDOW(win), child); }
static inline void shim_window_present(GtkWidget *win) { gtk_window_present(GTK_WINDOW(win)); }
static inline void shim_css_load(const char *path) {
    GtkCssProvider *provider = gtk_css_provider_new();
    gtk_css_provider_load_from_path(provider, path);
    gtk_style_context_add_provider_for_display(gdk_display_get_default(), provider, GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
}
static inline void shim_add_tick(GtkWidget *widget, GtkTickCallback cb) { gtk_widget_add_tick_callback(widget, cb, NULL, NULL); }

/* Text tags + widget management */
static inline GtkTextTag *shim_tag(GtkTextBuffer *buf, const char *name, const char *p1, const char *v1) {
    return gtk_text_buffer_create_tag(buf, name, p1, v1, NULL);
}
static inline GtkTextTag *shim_tag2(GtkTextBuffer *buf, const char *name, const char *p1, const char *v1, const char *p2, const char *v2) {
    return gtk_text_buffer_create_tag(buf, name, p1, v1, p2, v2, NULL);
}
static inline void shim_widget_destroy(GtkWidget *w) { gtk_widget_unparent(w); }
static inline GtkGesture *shim_click_add(GtkWidget *widget) {
    GtkGesture *g = gtk_gesture_click_new();
    gtk_widget_add_controller(widget, GTK_EVENT_CONTROLLER(g));
    return g;
}
static inline void shim_label_set_text(GtkWidget *w, const char *text) { gtk_label_set_text(GTK_LABEL(w), text); }
static inline void shim_scroll_bottom(GtkWidget *tv, GtkTextBuffer *buf) {
    GtkTextIter end; gtk_text_buffer_get_end_iter(buf, &end);
    gtk_text_view_scroll_to_iter(GTK_TEXT_VIEW(tv), &end, 0, 1, 0, 1);
}
static inline GtkEntryBuffer *shim_entry_buffer(GtkWidget *entry) { return gtk_entry_get_buffer(GTK_ENTRY(entry)); }
static inline const char *shim_entry_text(GtkWidget *entry) { return gtk_entry_buffer_get_text(gtk_entry_get_buffer(GTK_ENTRY(entry))); }
static inline void shim_entry_clear(GtkWidget *entry) { gtk_entry_buffer_set_text(gtk_entry_get_buffer(GTK_ENTRY(entry)), "", -1); }

/* Gesture click has a 5-arg signal ABI (gesture, n_press, x, y, user_data);
   forward only user_data through a fixed trampoline so Swift sees a plain fn. */
typedef void (*ShimPressedHandler)(void *userData);
static ShimPressedHandler shim_pressed_handler = NULL;
static void shim_pressed_trampoline(GtkGestureClick *g, int n, double x, double y, gpointer userData) {
    (void)g; (void)n; (void)x; (void)y;
    if (shim_pressed_handler) shim_pressed_handler(userData);
}
static inline void shim_on_pressed(GtkWidget *widget, void *userData) {
    GtkGesture *g = gtk_gesture_click_new();
    gtk_widget_add_controller(widget, GTK_EVENT_CONTROLLER(g));
    g_signal_connect_data(g, "pressed", G_CALLBACK(shim_pressed_trampoline), userData, NULL, G_CONNECT_DEFAULT);
}
static inline void shim_set_pressed_handler(ShimPressedHandler h) { shim_pressed_handler = h; }

/* Scroll pin: track near-bottom for streaming transcripts. */
static inline GtkAdjustment *shim_vadj(GtkWidget *scroll) { return gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(scroll)); }
static inline int shim_adj_near_bottom(GtkAdjustment *adj, int threshold) {
    double value = gtk_adjustment_get_value(adj);
    double upper = gtk_adjustment_get_upper(adj);
    double page = gtk_adjustment_get_page_size(adj);
    return (value + page >= upper - (double)threshold) ? 1 : 0;
}

/* Remove every child of a GtkBox (unparenting destroys each child). The files
   pane rebuilds its row list on refresh. */
static inline void shim_box_clear(GtkWidget *box) {
    GtkWidget *child;
    while ((child = gtk_widget_get_first_child(box)) != NULL) {
        gtk_widget_unparent(child);
    }
}

/* Per-row activation for list rows (files pane). A SEPARATE global handler
   slot from shim_pressed_handler so the app's button handling and the files
   list don't trample each other. `userData` is a Swift-retained box; the
   optional `destroyNotify` releases it when the connection is dropped. */
typedef void (*ShimRowHandler)(void *userData);
typedef void (*ShimRowDestroyNotify)(void *userData);
static ShimRowHandler shim_row_handler = NULL;
static void shim_row_trampoline(GtkGestureClick *g, int n, double x, double y, gpointer userData) {
    (void)g; (void)n; (void)x; (void)y;
    if (shim_row_handler) shim_row_handler(userData);
}
static inline void shim_on_row_activated(GtkWidget *widget, void *userData, ShimRowDestroyNotify destroyNotify) {
    GtkGesture *gesture = gtk_gesture_click_new();
    gtk_widget_add_controller(widget, GTK_EVENT_CONTROLLER(gesture));
    g_signal_connect_data(gesture, "pressed", G_CALLBACK(shim_row_trampoline), userData, destroyNotify, G_CONNECT_DEFAULT);
}
static inline void shim_set_row_handler(ShimRowHandler h) { shim_row_handler = h; }
static inline void shim_tag_colors(GtkTextTag *tag, const char *foreground, const char *background) {
    g_object_set(tag, "foreground", foreground, "background", background, NULL);
}
static inline void shim_tag_fg(GtkTextTag *tag, const char *foreground) {
    g_object_set(tag, "foreground", foreground, NULL);
}

/* Generic text-tag creation + property setters (theme-aware markdown). */
static inline GtkTextTag *shim_tag_new(GtkTextBuffer *buf, const char *name) {
    return gtk_text_buffer_create_tag(buf, name, NULL);
}
static inline void shim_tag_set_str(GtkTextTag *tag, const char *prop, const char *value) { g_object_set(tag, prop, value, NULL); }
static inline void shim_tag_set_int(GtkTextTag *tag, const char *prop, int value) { g_object_set(tag, prop, value, NULL); }
static inline void shim_tag_set_double(GtkTextTag *tag, const char *prop, double value) { g_object_set(tag, prop, value, NULL); }
static inline double shim_adj_value(GtkAdjustment *adj) { return gtk_adjustment_get_value(adj); }
static inline double shim_adj_upper(GtkAdjustment *adj) { return gtk_adjustment_get_upper(adj); }
static inline double shim_adj_page(GtkAdjustment *adj) { return gtk_adjustment_get_page_size(adj); }

/* Stack for pane switching */
static inline GtkWidget *shim_stack(void) { return gtk_stack_new(); }
static inline void shim_stack_add(GtkWidget *stack, GtkWidget *child, const char *name) { gtk_stack_add_named(GTK_STACK(stack), child, name); }
static inline void shim_stack_show(GtkWidget *stack, const char *name) { gtk_stack_set_visible_child_name(GTK_STACK(stack), name); }
static inline void shim_stack_set_transition(GtkWidget *stack) { gtk_stack_set_transition_type(GTK_STACK(stack), GTK_STACK_TRANSITION_TYPE_SLIDE_LEFT_RIGHT); gtk_stack_set_transition_duration(GTK_STACK(stack), 180); }
static inline void shim_widget_show(GtkWidget *w) { gtk_widget_set_visible(w, 1); }
static inline void shim_widget_hide(GtkWidget *w) { gtk_widget_set_visible(w, 0); }
