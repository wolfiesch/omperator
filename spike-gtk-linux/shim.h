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
