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
static inline void shim_css_class_remove(GtkWidget *w, const char *name) { gtk_widget_remove_css_class(w, name); }
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

/* ── Transcript widgets ─────────────────────────────────────
   Helpers for the per-entry transcript widget factory
   (TranscriptWidgets.swift): alignment, opacity, clipboard,
   scroll policy, code text-view, label text runs. */

static inline void shim_widget_halign_end(GtkWidget *w) { gtk_widget_set_halign(w, GTK_ALIGN_END); }
static inline void shim_widget_opacity(GtkWidget *w, double opacity) { gtk_widget_set_opacity(w, opacity); }

static inline void shim_clipboard_set_text(const char *text) {
    GdkDisplay *display = gdk_display_get_default();
    if (display == NULL) return;
    GdkClipboard *clipboard = gdk_display_get_clipboard(display);
    gdk_clipboard_set_text(clipboard, text);
}

/* Scroll policies (GTK_POLICY_AUTOMATIC/ALWAYS/NEVER) — code blocks scroll
   horizontally (AUTOMATIC) but never vertically (NEVER), so long blocks grow
   into the transcript's outer scroll instead of nesting scrollbars. */
static inline void shim_scrolled_policy(GtkWidget *scroll, GtkPolicyType hpolicy, GtkPolicyType vpolicy) {
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroll), hpolicy, vpolicy);
}

/* Code text views must not wrap: the longest line drives the width so the
   horizontal scroller engages. (shim_text_view_setup enables WORD_CHAR.) */
static inline void shim_text_view_nowrap(GtkWidget *tv) { gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(tv), GTK_WRAP_NONE); }

static inline void shim_label_selectable(GtkWidget *w) { gtk_label_set_selectable(GTK_LABEL(w), 1); }
static inline void shim_label_wrap(GtkWidget *w) {
    gtk_label_set_wrap(GTK_LABEL(w), 1);
    gtk_label_set_wrap_mode(GTK_LABEL(w), GTK_WRAP_WORD_CHAR);
    gtk_label_set_xalign(GTK_LABEL(w), 0.0);
}

/* Wrapping label for the transcript column. Deliberately uses GTK_WRAP_WORD,
   NOT the WORD_CHAR mode that shim_label_wrap sets: on GTK 4.22 a GtkLabel
   measured in GTK_WRAP_WORD_CHAR mode reports its one-line width as BOTH its
   minimum and natural width (the "as many line breaks as possible" minimum
   computation breaks for WORD_CHAR), so such a label can never shrink below
   the full unwrapped text width. Inside the transcript scrolled window that
   forces the column to the widest paragraph's one-line width: toggling the
   rail/pane sidebar never shrinks the column, the label never re-wraps, and
   the right edge of the text is cut off. GTK_WRAP_WORD measures correctly
   (min = longest word, natural = capped wrap width), so labels re-wrap at
   any allocated width, both directions. */
static inline void shim_label_wrap_words(GtkWidget *w) {
    gtk_label_set_wrap(GTK_LABEL(w), 1);
    gtk_label_set_wrap_mode(GTK_LABEL(w), GTK_WRAP_WORD);
    gtk_label_set_xalign(GTK_LABEL(w), 0.0);
}
static inline void shim_label_set_markup(GtkWidget *w, const char *markup) { gtk_label_set_markup(GTK_LABEL(w), markup); }
static inline void shim_label_max_width_chars(GtkWidget *w, int chars) { gtk_label_set_max_width_chars(GTK_LABEL(w), chars); }

static inline GtkWidget *shim_separator(int horizontal) {
    return gtk_separator_new(horizontal ? GTK_ORIENTATION_HORIZONTAL : GTK_ORIENTATION_VERTICAL);
}

/* Weak-ref a text tag so the widget factory can drop its tracking entry the
   moment the tag is finalized (theme re-tints must never touch a freed tag —
   transcript clears destroy buffers, and their tags go with them). */
typedef void (*ShimTagGoneHandler)(void *userData, void *whereObjectWas);
static inline void shim_tag_track_gone(GtkTextTag *tag, void *userData, ShimTagGoneHandler notify) {
    g_object_weak_ref(G_OBJECT(tag), (GWeakNotify)notify, userData);
}

/* Append a run and tag exactly that run (unlike shim_text_append_code, which
   tags from the current line start — that one is for whole-line diff/block
   runs). Used by the syntax highlighter to tag individual tokens. */
static inline void shim_text_append_tagged(GtkTextBuffer *buf, const char *text, GtkTextTag *tag) {
    GtkTextIter end;
    gtk_text_buffer_get_end_iter(buf, &end);
    gint offset = gtk_text_iter_get_offset(&end);
    gtk_text_buffer_insert(buf, &end, text, -1);
    if (tag != NULL) {
        GtkTextIter start;
        gtk_text_buffer_get_iter_at_offset(buf, &start, offset);
        GtkTextIter newEnd;
        gtk_text_buffer_get_end_iter(buf, &newEnd);
        gtk_text_buffer_apply_tag(buf, tag, &start, &newEnd);
    }
}
static inline void shim_scroll_to_max(GtkWidget *scroll) {
    GtkAdjustment *adj = gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(scroll));
    gtk_adjustment_set_value(adj, gtk_adjustment_get_upper(adj) - gtk_adjustment_get_page_size(adj));
}

/* Window sizing for mini mode */
static inline void shim_window_resize(GtkWidget *win, int width, int height) { gtk_window_set_default_size(GTK_WINDOW(win), width, height); }
static inline void shim_window_get_size(GtkWidget *win, int *width, int *height) { gtk_window_get_default_size(GTK_WINDOW(win), width, height); }
static inline GtkWidget *shim_spacer(void) { GtkWidget *s = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0); gtk_widget_set_hexpand(s, 1); return s; }

/* ── Compositor pin (always-on-top) ──────────────────────────
   X11 EWMH support for CompositorPin.swift. `gdk_x11_*` resolve from
   libgtk-4 itself (both backends are built in on this distro), while the
   Xlib entry points are resolved at runtime via dlopen: GTK's pkg-config
   link line does not include -lX11, so link-time Xlib references would be
   undefined, but libX11 is already loaded into the process as libgtk-4's
   dependency. dlopen/dlsym is the only zero-dependency way to reach it.
   Guarded by GDK_WINDOWING_X11 (defined in gdkconfig.h via <gtk/gtk.h>)
   so a hypothetical wayland-only GTK build still compiles. */

#ifdef GDK_WINDOWING_X11
#include <gdk/x11/gdkx.h>
#include <X11/Xatom.h>
#include <dlfcn.h>

static inline const char *shim_window_title(GtkWidget *win) {
    return win ? gtk_window_get_title(GTK_WINDOW(win)) : NULL;
}

/* The toplevel X11 window id of a realized GTK window, or 0 when the
   surface is not an X11 surface (Wayland, or window not yet realized). */
static inline unsigned long shim_x11_xid(GtkWidget *win) {
    if (win == NULL) return 0;
    GdkSurface *surface = gtk_native_get_surface(GTK_NATIVE(win));
    if (surface == NULL || !GDK_IS_X11_SURFACE(surface)) return 0;
    return (unsigned long)gdk_x11_surface_get_xid(surface);
}

/* Xlib function table resolved from the already-loaded libX11 (glibc's
   dlopen/dlsym are always available — no extra link flags). */
typedef Display *(*ShimXOpenDisplay)(const char *);
typedef int (*ShimXCloseDisplay)(Display *);
typedef Atom (*ShimXInternAtom)(Display *, const char *, Bool);
typedef int (*ShimXGetWindowProperty)(Display *, Window, Atom, long, long, Bool, Atom, Atom *, int *, unsigned long *, unsigned long *, unsigned char **);
typedef int (*ShimXChangeProperty)(Display *, Window, Atom, Atom, int, int, const unsigned char *, int);
typedef int (*ShimXSync)(Display *, Bool);
typedef int (*ShimXFree)(void *);

typedef struct {
    ShimXOpenDisplay open_display;
    ShimXCloseDisplay close_display;
    ShimXInternAtom intern_atom;
    ShimXGetWindowProperty get_window_property;
    ShimXChangeProperty change_property;
    ShimXSync sync;
    ShimXFree free;
} ShimXlib;

static inline int shim_x11_load(ShimXlib *x) {
    void *h = dlopen("libX11.so.6", RTLD_LAZY);
    if (h == NULL) return 0;
    union { void *p; ShimXOpenDisplay fn; } u;
#define SHIM_DLSYM(name, field) do { u.p = dlsym(h, name); x->field = u.fn; if (x->field == NULL) return 0; } while (0)
    SHIM_DLSYM("XOpenDisplay", open_display);
    SHIM_DLSYM("XCloseDisplay", close_display);
    SHIM_DLSYM("XInternAtom", intern_atom);
    SHIM_DLSYM("XGetWindowProperty", get_window_property);
    SHIM_DLSYM("XChangeProperty", change_property);
    SHIM_DLSYM("XSync", sync);
    SHIM_DLSYM("XFree", free);
#undef SHIM_DLSYM
    return 1;
}

/* Add (above != 0) or remove (above == 0) EWMH _NET_WM_STATE_ABOVE on the
   given X11 window id. Idempotent: reads the current state list, rewrites it
   with the ABOVE bit added or removed. Returns 1 on success, 0 when the
   display cannot be opened (headless) — the caller treats 0 as a no-op. */
static inline int shim_x11_set_above(unsigned long xid, int above) {
    if (xid == 0) return 0;
    ShimXlib x;
    if (!shim_x11_load(&x)) return 0;
    Display *dpy = x.open_display(NULL);
    if (dpy == NULL) return 0;
    Window win = (Window)xid;
    Atom net_wm_state = x.intern_atom(dpy, "_NET_WM_STATE", False);
    Atom atom_above = x.intern_atom(dpy, "_NET_WM_STATE_ABOVE", False);

    Atom actual_type = None;
    int actual_format = 0;
    unsigned long nitems = 0, bytes_after = 0;
    unsigned char *prop = NULL;
    int ok = x.get_window_property(dpy, win, net_wm_state, 0, 256, False, XA_ATOM,
                                   &actual_type, &actual_format, &nitems, &bytes_after, &prop);
    Atom *atoms = (ok == Success && actual_format == 32 && prop != NULL) ? (Atom *)prop : NULL;
    int has = 0;
    for (unsigned long i = 0; i < nitems; i++) {
        if (atoms[i] == atom_above) { has = 1; break; }
    }
    if ((above && has) || (!above && !has)) {
        if (prop != NULL) x.free(prop);
        x.close_display(dpy);
        return 1;
    }

    unsigned long total = above ? nitems + 1 : nitems - 1;
    Atom *next = NULL;
    if (above) {
        next = (Atom *)calloc(total, sizeof(Atom));
        memcpy(next, atoms, nitems * sizeof(Atom));
        next[nitems] = atom_above;
    } else {
        next = (Atom *)malloc(total * sizeof(Atom));
        unsigned long j = 0;
        for (unsigned long i = 0; i < nitems; i++) {
            if (atoms[i] != atom_above) next[j++] = atoms[i];
        }
    }
    x.change_property(dpy, win, net_wm_state, XA_ATOM, 32, PropModeReplace,
                      (unsigned char *)next, (int)total);
    x.sync(dpy, False);
    free(next);
    if (prop != NULL) x.free(prop);
    x.close_display(dpy);
    return 1;
}
#endif /* GDK_WINDOWING_X11 */

/* ── Onboarding & settings surface ──────────────────────────
   First-run login overlay (GtkOverlay), password-masked entries,
   and the settings popover's check buttons. */

static inline GtkWidget *shim_overlay_new(void) { return gtk_overlay_new(); }
static inline void shim_overlay_set_child(GtkWidget *overlay, GtkWidget *child) { gtk_overlay_set_child(GTK_OVERLAY(overlay), child); }
static inline void shim_overlay_add_overlay(GtkWidget *overlay, GtkWidget *child) { gtk_overlay_add_overlay(GTK_OVERLAY(overlay), child); }

/* Fill the parent: expand on both axes and stretch to the full allocation
   (used for the onboarding backdrop so it covers the whole window). */
static inline void shim_widget_fill(GtkWidget *w) {
    gtk_widget_set_hexpand(w, 1);
    gtk_widget_set_vexpand(w, 1);
    gtk_widget_set_halign(w, GTK_ALIGN_FILL);
    gtk_widget_set_valign(w, GTK_ALIGN_FILL);
}
static inline void shim_widget_halign_center(GtkWidget *w) { gtk_widget_set_halign(w, GTK_ALIGN_CENTER); }
static inline void shim_widget_valign_center(GtkWidget *w) { gtk_widget_set_valign(w, GTK_ALIGN_CENTER); }

/* Password masking: visibility == 0 renders the input as dots. */
static inline void shim_entry_set_visibility(GtkWidget *entry, int visible) { gtk_entry_set_visibility(GTK_ENTRY(entry), visible); }
static inline void shim_entry_set_placeholder(GtkWidget *entry, const char *text) { gtk_entry_set_placeholder_text(GTK_ENTRY(entry), text); }

/* Disable a widget (login button while signing in). */
static inline void shim_widget_sensitive(GtkWidget *w, int sensitive) { gtk_widget_set_sensitive(w, sensitive); }

/* Check buttons for the settings popover (plain-language toggles). */
static inline GtkWidget *shim_check_button(const char *label) { return gtk_check_button_new_with_label(label); }
static inline int shim_check_active(GtkWidget *w) { return gtk_check_button_get_active(GTK_CHECK_BUTTON(w)); }
static inline void shim_check_set_active(GtkWidget *w, int active) { gtk_check_button_set_active(GTK_CHECK_BUTTON(w), active); }

/* Popover for the settings surface. Attach via gtk_widget_set_parent and
   pop up with gtk_popover_popup: gtk_popover_present does not show the
   popover in GTK 4.22 (visible stays FALSE after present()). */
static inline GtkWidget *shim_popover_new(void) { return gtk_popover_new(); }
static inline void shim_popover_set_child(GtkWidget *popover, GtkWidget *child) { gtk_popover_set_child(GTK_POPOVER(popover), child); }
static inline void shim_popover_attach(GtkWidget *popover, GtkWidget *anchor) { gtk_widget_set_parent(GTK_WIDGET(popover), anchor); }
static inline void shim_popover_popup(GtkWidget *popover) { gtk_popover_popup(GTK_POPOVER(popover)); }

/* Visibility queries (settings panel toggle state). */
static inline int shim_widget_visible(GtkWidget *w) { return gtk_widget_get_visible(w); }

/* Scroll position save/restore (per-session scroll memory). */
static inline double shim_scroll_get(GtkWidget *scroll) {
    return gtk_adjustment_get_value(gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(scroll)));
}
static inline void shim_scroll_set(GtkWidget *scroll, double value) {
    GtkAdjustment *adj = gtk_scrolled_window_get_vadjustment(GTK_SCROLLED_WINDOW(scroll));
    gtk_adjustment_set_value(adj, value);
}
static inline void shim_idle(GSourceFunc cb, gpointer userData) { g_idle_add(cb, userData); }
static inline void shim_track_gone(void *gobject, void *userData, ShimTagGoneHandler notify) {
    g_object_weak_ref(G_OBJECT(gobject), (GWeakNotify)notify, userData);
}


/* A flat button wrapping a custom child (card headers) — GtkButton activation
   works reliably inside a GtkScrolledWindow where a bubble-phase
   GtkGestureClick on a plain box can lose the press to the scroller's drag. */
static inline GtkWidget *shim_button_child(GtkWidget *child) {
    GtkWidget *b = gtk_button_new();
    gtk_button_set_child(GTK_BUTTON(b), child);
    return b;
}

/* Frame-tick callback: fires each frame right before draw, AFTER layout — so
   reading the content height here is never stale (unlike reacting to the
   adjustment "changed" signal, which fires before the new text is measured).
   Used to keep a streaming transcript pinned to the true bottom. */
static inline void shim_add_tick(GtkWidget *w, GtkTickCallback cb, gpointer userData) {
    gtk_widget_add_tick_callback(w, cb, userData, NULL);
}

/* ── Composer (multiline, wrapping) ─────────────────────────
   GtkTextView with word-char wrap inside a GtkScrolledWindow whose
   min/max content heights give auto-grow to ~N lines, then internal
   scroll. Enter-to-send is wired on the Swift side via shim_on_key. */

static inline GtkWidget *shim_composer_view(void) {
    GtkWidget *tv = gtk_text_view_new();
    gtk_text_view_set_wrap_mode(GTK_TEXT_VIEW(tv), GTK_WRAP_WORD_CHAR);
    gtk_text_view_set_accepts_tab(GTK_TEXT_VIEW(tv), FALSE);
    gtk_widget_set_hexpand(tv, 1);
    return tv;
}

static inline void shim_scrolled_content_height(GtkWidget *scroll, int minHeight, int maxHeight) {
    gtk_scrolled_window_set_min_content_height(GTK_SCROLLED_WINDOW(scroll), minHeight);
    gtk_scrolled_window_set_max_content_height(GTK_SCROLLED_WINDOW(scroll), maxHeight);
    /* Without natural-height propagation the window requests only its
       minimum and the text view clips past ~2 lines; with it the composer
       grows line-by-line up to maxHeight, then scrolls internally. */
    gtk_scrolled_window_set_propagate_natural_height(GTK_SCROLLED_WINDOW(scroll), TRUE);
    gtk_scrolled_window_set_policy(GTK_SCROLLED_WINDOW(scroll), GTK_POLICY_NEVER, GTK_POLICY_AUTOMATIC);
}

/* Full buffer text. Returns a NEWLY ALLOCATED string — free with shim_free. */
static inline char *shim_buffer_text(GtkTextBuffer *buf) {
    GtkTextIter start, end;
    gtk_text_buffer_get_bounds(buf, &start, &end);
    return gtk_text_buffer_get_text(buf, &start, &end, TRUE);
}

static inline void shim_buffer_set_text(GtkTextBuffer *buf, const char *text) {
    gtk_text_buffer_set_text(buf, text, -1);
}

static inline void shim_free(void *ptr) { g_free(ptr); }

/* Scroll a text view's cursor into view after programmatic edits (send clear). */
static inline void shim_text_scroll_cursor(GtkWidget *tv) {
    GtkTextBuffer *buf = gtk_text_view_get_buffer(GTK_TEXT_VIEW(tv));
    GtkTextMark *mark = gtk_text_buffer_get_insert(buf);
    gtk_text_view_scroll_mark_onscreen(GTK_TEXT_VIEW(tv), mark);
}

/* ── Generic key controller ─────────────────────────────────
   One global handler slot (same pattern as shim_pressed_handler): keyval +
   modifier state + the caller's userData box. Return nonzero to swallow. */

typedef int (*ShimKeyHandler)(unsigned keyval, unsigned state, void *userData);
static ShimKeyHandler shim_key_handler = NULL;
static gboolean shim_key_trampoline(GtkEventControllerKey *ctl, unsigned keyval, unsigned keycode, GdkModifierType state, gpointer userData) {
    (void)ctl; (void)keycode;
    if (shim_key_handler) return shim_key_handler(keyval, (unsigned)state, userData) ? TRUE : FALSE;
    return FALSE;
}
static inline void shim_on_key(GtkWidget *widget, void *userData) {
    GtkEventController *ctl = gtk_event_controller_key_new();
    gtk_widget_add_controller(widget, ctl);
    g_signal_connect_data(ctl, "key-pressed", G_CALLBACK(shim_key_trampoline), userData, NULL, G_CONNECT_DEFAULT);
}
static inline void shim_set_key_handler(ShimKeyHandler h) { shim_key_handler = h; }

/* ── Pictures / textures ─────────────────────────────────────
   gdk_texture_new_from_bytes decodes PNG/JPEG/WebP/etc. through gdk-pixbuf
   loaders — no extra dependency. NULL on decode failure. */

static inline GtkWidget *shim_picture(void) { return gtk_picture_new(); }

static inline void *shim_texture_from_bytes(const unsigned char *data, unsigned long len) {
    GBytes *bytes = g_bytes_new(data, len);
    GError *err = NULL;
    void *tex = gdk_texture_new_from_bytes(bytes, &err);
    g_bytes_unref(bytes);
    if (err) { g_error_free(err); return NULL; }
    return tex;
}

/* set_paintable adds its own ref; callers unref their texture handle after. */
static inline void shim_picture_set_texture(GtkWidget *picture, void *texture) {
    gtk_picture_set_paintable(GTK_PICTURE(picture), GDK_PAINTABLE(texture));
}

static inline void shim_picture_fit(GtkWidget *picture) {
    gtk_picture_set_content_fit(GTK_PICTURE(picture), GTK_CONTENT_FIT_CONTAIN);
    gtk_picture_set_can_shrink(GTK_PICTURE(picture), TRUE);
}

static inline int shim_texture_width(void *t) { return gdk_texture_get_width(GDK_TEXTURE(t)); }
static inline int shim_texture_height(void *t) { return gdk_texture_get_height(GDK_TEXTURE(t)); }
static inline void shim_unref(void *obj) { if (obj) g_object_unref(obj); }

/* Clipboard textures → PNG bytes for prompt upload (paste path). The returned
   GBytes is caller-owned: copy then shim_gbytes_free. */
static inline GBytes *shim_texture_png_bytes(void *texture) {
    return gdk_texture_save_to_png_bytes(GDK_TEXTURE(texture));
}
static inline const unsigned char *shim_gbytes_data(GBytes *bytes, unsigned long *len) {
    gsize size = 0;
    const unsigned char *p = g_bytes_get_data(bytes, &size);
    if (len) *len = (unsigned long)size;
    return p;
}
static inline void shim_gbytes_free(GBytes *bytes) { if (bytes) g_bytes_unref(bytes); }

/* ── File paths callback (open dialog + drag & drop) ─────────
   One handler slot for "user picked/dropped these files"; the Swift side
   dispatches on the userData box. Paths are owned by the shim — copy them. */

typedef void (*ShimPathsHandler)(void *userData, char **paths, int count);
static ShimPathsHandler shim_paths_handler = NULL;
static inline void shim_set_paths_handler(ShimPathsHandler h) { shim_paths_handler = h; }

/* Native open dialog (GTK 4.10+): image filter, multi-select. */
static void shim_dialog_done(GObject *source, GAsyncResult *res, gpointer userData) {
    GError *err = NULL;
    GListModel *files = gtk_file_dialog_open_multiple_finish(GTK_FILE_DIALOG(source), res, &err);
    if (err) { g_error_free(err); return; }
    if (!files) return;
    guint n = g_list_model_get_n_items(files);
    char **paths = g_new0(char *, n);
    int count = 0;
    for (guint i = 0; i < n; i++) {
        GFile *f = G_FILE(g_list_model_get_item(files, i));
        char *p = g_file_get_path(f);
        if (p) paths[count++] = p;
        g_object_unref(f);
    }
    if (shim_paths_handler && count > 0) shim_paths_handler(userData, paths, count);
    for (int i = 0; i < count; i++) g_free((void *)paths[i]);
    g_free(paths);
    g_object_unref(files);
}

static inline void shim_open_images_dialog(GtkWidget *parent, void *userData) {
    GtkFileDialog *dialog = gtk_file_dialog_new();
    gtk_file_dialog_set_title(dialog, "Attach images");
    GListStore *filters = g_list_store_new(GTK_TYPE_FILE_FILTER);
    GtkFileFilter *filter = gtk_file_filter_new();
    gtk_file_filter_set_name(filter, "Images");
    gtk_file_filter_add_mime_type(filter, "image/png");
    gtk_file_filter_add_mime_type(filter, "image/jpeg");
    gtk_file_filter_add_mime_type(filter, "image/webp");
    gtk_file_filter_add_mime_type(filter, "image/gif");
    g_list_store_append(filters, filter);
    gtk_file_dialog_set_filters(dialog, G_LIST_MODEL(filters));
    g_object_unref(filters);
    g_object_unref(filter);
    gtk_file_dialog_open_multiple(dialog, parent ? GTK_WINDOW(parent) : NULL, NULL, shim_dialog_done, userData);
}

/* Drag & drop of files (GdkFileList) onto the composer area. */
static gboolean shim_drop_trampoline(GtkDropTarget *target, const GValue *value, double x, double y, gpointer userData) {
    (void)target; (void)x; (void)y;
    if (!G_VALUE_HOLDS(value, GDK_TYPE_FILE_LIST)) return FALSE;
    GdkFileList *list = g_value_get_boxed(value);
    GSList *files = gdk_file_list_get_files(list);
    int count = g_slist_length(files);
    if (count <= 0) return FALSE;
    char **paths = g_new0(char *, count);
    int n = 0;
    for (GSList *l = files; l; l = l->next) {
        char *p = g_file_get_path(G_FILE(l->data));
        if (p) paths[n++] = p;
    }
    if (shim_paths_handler && n > 0) shim_paths_handler(userData, paths, n);
    for (int i = 0; i < n; i++) g_free((void *)paths[i]);
    g_free(paths);
    return n > 0;
}

static inline void shim_drop_files(GtkWidget *widget, void *userData) {
    GtkDropTarget *target = gtk_drop_target_new(GDK_TYPE_FILE_LIST, GDK_ACTION_COPY);
    g_signal_connect_data(target, "drop", G_CALLBACK(shim_drop_trampoline), userData, NULL, G_CONNECT_DEFAULT);
    gtk_widget_add_controller(widget, GTK_EVENT_CONTROLLER(target));
}

/* ── Clipboard image paste ───────────────────────────────────
   Fully async read: gdk_clipboard_read_async + g_input_stream_read_bytes_async
   chained to EOF. A BLOCKING read deadlocks the X11 backend — the selection
   data flows through X events that the blocked main loop would have to
   dispatch. Bytes arrive with their original mime (no re-encode). */

typedef void (*ShimClipboardBytesHandler)(void *userData, const unsigned char *data, unsigned long len, const char *mime);
static ShimClipboardBytesHandler shim_clipboard_bytes_handler = NULL;
static inline void shim_set_clipboard_bytes_handler(ShimClipboardBytesHandler h) { shim_clipboard_bytes_handler = h; }

typedef struct {
    GByteArray *buf;
    GInputStream *stream;
    char *mime;
    void *userData;
} ShimClipRead;

/* Only one clipboard read in flight — concurrent read_async operations on
   the same X11 selection race inside GDK (the losing stream is finalized
   while its ctx still points at it). Cleared on completion. */
static int shim_clip_reading = 0;

static void shim_clip_chunk_done(GObject *source, GAsyncResult *res, gpointer userData) {
    ShimClipRead *ctx = userData;
    GError *err = NULL;
    /* ONE bounded read, no re-arm: the X11 clipboard stream is a single-shot
       transfer that completes with the payload buffered; a second
       read_bytes_async on it crashes in GIO dispatch. 32 MB covers any
       clipboard image (the wire caps prompt images at 20 MB). */
    GBytes *chunk = g_input_stream_read_bytes_finish(ctx->stream, res, &err);
    if (err) { g_error_free(err); }
    if (chunk) {
        gsize n = g_bytes_get_size(chunk);
        if (n > 0) g_byte_array_append(ctx->buf, (const guint8 *)g_bytes_get_data(chunk, NULL), n);
        g_bytes_unref(chunk);
    }
    if (shim_clipboard_bytes_handler) {
        shim_clipboard_bytes_handler(ctx->userData, ctx->buf->data, (unsigned long)ctx->buf->len, ctx->mime);
    }
    g_object_unref(ctx->stream);
    g_byte_array_free(ctx->buf, TRUE);
    /* ctx->mime is NOT freed: gdk_clipboard_read_finish's out_mime string is
       borrowed clipboard storage on this stack (freeing it aborts with
       "free(): invalid pointer"); the clipboard outlives the read. */
    g_free(ctx);
    shim_clip_reading = 0;
}

static void shim_clipboard_bytes_done(GObject *source, GAsyncResult *res, gpointer userData) {
    GError *err = NULL;
    char *out_mime = NULL;
    GInputStream *stream = gdk_clipboard_read_finish(GDK_CLIPBOARD(source), res, (const char **)&out_mime, &err);
    if (err) { g_error_free(err); }
    if (!stream) {
        if (shim_clipboard_bytes_handler) shim_clipboard_bytes_handler(userData, NULL, 0, NULL);
        /* out_mime: borrowed, do not free (see shim_clip_chunk_done). */
        shim_clip_reading = 0;
        return;
    }
    ShimClipRead *ctx = g_new0(ShimClipRead, 1);
    ctx->buf = g_byte_array_new();
    ctx->stream = stream;
    ctx->mime = out_mime;
    ctx->userData = userData;
    g_input_stream_read_bytes_async(ctx->stream, 32 * 1024 * 1024, G_PRIORITY_DEFAULT, NULL, shim_clip_chunk_done, ctx);
}

static inline int shim_clipboard_has_image(GtkWidget *widget) {
    GdkClipboard *cb = gtk_widget_get_clipboard(widget);
    GdkContentFormats *formats = gdk_clipboard_get_formats(cb);
    return gdk_content_formats_contain_mime_type(formats, "image/png")
        || gdk_content_formats_contain_mime_type(formats, "image/jpeg")
        || gdk_content_formats_contain_mime_type(formats, "image/webp")
        || gdk_content_formats_contain_mime_type(formats, "image/gif");
}

static inline void shim_clipboard_read_image(GtkWidget *widget, void *userData) {
    if (shim_clip_reading) {
        /* Complete empty so the caller's box/flag state unwinds cleanly. */
        if (shim_clipboard_bytes_handler) shim_clipboard_bytes_handler(userData, NULL, 0, NULL);
        return;
    }
    shim_clip_reading = 1;
    static const char *mimes[] = { "image/png", "image/jpeg", "image/webp", "image/gif", NULL };
    GdkClipboard *cb = gtk_widget_get_clipboard(widget);
    gdk_clipboard_read_async(cb, mimes, G_PRIORITY_DEFAULT, NULL, shim_clipboard_bytes_done, userData);
}

/* ── Misc widgets ─────────────────────────────────────────── */

static inline void shim_box_remove(GtkWidget *box, GtkWidget *child) {
    gtk_box_remove(GTK_BOX(box), child);
}

static inline void shim_widget_size_wh(GtkWidget *w, int width, int height) {
    gtk_widget_set_size_request(w, width, height);
}

static inline void shim_widget_margins(GtkWidget *w, int margin) {
    gtk_widget_set_margin_top(w, margin);
    gtk_widget_set_margin_bottom(w, margin);
    gtk_widget_set_margin_start(w, margin);
    gtk_widget_set_margin_end(w, margin);
}

/* Overlay removal (lightbox close) + explicit ref for async widget loads. */
static inline void shim_overlay_remove(GtkWidget *overlay, GtkWidget *child) {
    gtk_overlay_remove_overlay(GTK_OVERLAY(overlay), child);
}
static inline void *shim_ref(void *obj) { return obj ? g_object_ref(obj) : NULL; }

/* Composer wrap: stop the scrolled window propagating the text view's
   UNWRAPPED natural width (a long line would otherwise stretch the row past
   the window instead of wrapping). Height propagation stays on so the
   min/max content heights give auto-grow-then-scroll. */
static inline void shim_scrolled_no_width_propagate(GtkWidget *scroll) {
    gtk_scrolled_window_set_propagate_natural_width(GTK_SCROLLED_WINDOW(scroll), FALSE);
}

/* ── Copy chrome (context menu + hover) ─────────────────────
   Right-click gesture (button 3) that shares the global pressed-handler
   slot, click position captured in ROOT-window coordinates so a shared
   window-anchored popover can be positioned anywhere. */

static double shim_menu_x = 0, shim_menu_y = 0;

static void shim_rightclick_trampoline(GtkGestureClick *g, int n, double x, double y, gpointer userData) {
    (void)n;
    GtkWidget *w = gtk_event_controller_get_widget(GTK_EVENT_CONTROLLER(g));
    GtkRoot *root = w ? gtk_widget_get_root(w) : NULL;
    graphene_point_t in = GRAPHENE_POINT_INIT((float)x, (float)y);
    graphene_point_t out;
    gboolean okc = root && gtk_widget_compute_point(w, GTK_WIDGET(root), &in, &out);
    if (okc) {
        shim_menu_x = out.x;
        shim_menu_y = out.y;
    } else {
        shim_menu_x = x;
        shim_menu_y = y;
    }
    if (shim_pressed_handler) shim_pressed_handler(userData);
}

static inline void shim_menu_click_pos(double *x, double *y) { *x = shim_menu_x; *y = shim_menu_y; }

static inline void shim_on_right_click(GtkWidget *widget, void *userData) {
    GtkGesture *g = gtk_gesture_click_new();
    gtk_gesture_single_set_button(GTK_GESTURE_SINGLE(g), 3);
    /* CAPTURE phase: claim the sequence before inner text views show their
       own editing menu (Cut/Copy/Paste) — element copy wins on right-click. */
    gtk_event_controller_set_propagation_phase(GTK_EVENT_CONTROLLER(g), GTK_PHASE_CAPTURE);
    g_signal_connect_data(g, "pressed", G_CALLBACK(shim_rightclick_trampoline), userData, NULL, G_CONNECT_DEFAULT);
    gtk_widget_add_controller(widget, GTK_EVENT_CONTROLLER(g));
}



/* Popover positioning (window coordinates) + dismiss. */
static inline void shim_popover_point_to(GtkWidget *popover, double x, double y) {
    GdkRectangle r = { (int)x, (int)y, 1, 1 };
    gtk_popover_set_pointing_to(GTK_POPOVER(popover), &r);
}
static inline void shim_popover_popdown(GtkWidget *popover) { gtk_popover_popdown(GTK_POPOVER(popover)); }

static inline void shim_widget_valign_start(GtkWidget *w) { gtk_widget_set_valign(w, GTK_ALIGN_START); }
static inline void shim_widget_valign_end(GtkWidget *w) { gtk_widget_set_valign(w, GTK_ALIGN_END); }

/* Copy an image to the clipboard as PNG (texture → PNG bytes → provider). */
static inline void shim_clipboard_set_texture(void *texture) {
    GdkDisplay *display = gdk_display_get_default();
    if (!display || !texture) return;
    GdkClipboard *clipboard = gdk_display_get_clipboard(display);
    GBytes *bytes = gdk_texture_save_to_png_bytes(GDK_TEXTURE(texture));
    GdkContentProvider *provider = gdk_content_provider_new_for_bytes("image/png", bytes);
    gdk_clipboard_set_content(clipboard, provider);
    g_object_unref(provider);
    g_bytes_unref(bytes);
}

/* ── Rail popout/popin + resizable dividers ─────────────────
   GtkRevealer gives the native slide transition (width animates, child
   clips). Drag gesture drives the rail/pane width; snap-collapse handled
   on the Swift side. */

static inline GtkWidget *shim_revealer(void) {
    GtkWidget *r = gtk_revealer_new();
    gtk_revealer_set_transition_type(GTK_REVEALER(r), GTK_REVEALER_TRANSITION_TYPE_SLIDE_RIGHT);
    gtk_revealer_set_transition_duration(GTK_REVEALER(r), 220);
    return r;
}
static inline void shim_revealer_set_child(GtkWidget *r, GtkWidget *child) { gtk_revealer_set_child(GTK_REVEALER(r), child); }
static inline void shim_revealer_set_reveal(GtkWidget *r, int reveal) { gtk_revealer_set_reveal_child(GTK_REVEALER(r), reveal); }
static inline int shim_revealer_revealed(GtkWidget *r) { return gtk_revealer_get_child_revealed(GTK_REVEALER(r)); }

typedef void (*ShimDragHandler)(void *userData, double offsetX, double offsetY, int ended);
static ShimDragHandler shim_drag_handler = NULL;
static void shim_drag_update_trampoline(GtkGestureDrag *g, double ox, double oy, gpointer ud) {
    (void)g;
    if (shim_drag_handler) shim_drag_handler(ud, ox, oy, 0);
}
static void shim_drag_end_trampoline(GtkGestureDrag *g, double ox, double oy, gpointer ud) {
    (void)g;
    if (shim_drag_handler) shim_drag_handler(ud, ox, oy, 1);
}
/* ended==2 marks drag-begin so the caller captures the start width. */
static void shim_drag_begin_trampoline(GtkGestureDrag *g, double x, double y, gpointer ud) {
    (void)g; (void)x; (void)y;
    if (shim_drag_handler) shim_drag_handler(ud, 0, 0, 2);
}
static inline void shim_on_drag(GtkWidget *widget, void *userData) {
    GtkGesture *g = gtk_gesture_drag_new();
    gtk_gesture_single_set_button(GTK_GESTURE_SINGLE(g), 0);
    g_signal_connect_data(g, "drag-begin", G_CALLBACK(shim_drag_begin_trampoline), userData, NULL, G_CONNECT_DEFAULT);
    g_signal_connect_data(g, "drag-update", G_CALLBACK(shim_drag_update_trampoline), userData, NULL, G_CONNECT_DEFAULT);
    g_signal_connect_data(g, "drag-end", G_CALLBACK(shim_drag_end_trampoline), userData, NULL, G_CONNECT_DEFAULT);
    gtk_widget_add_controller(widget, GTK_EVENT_CONTROLLER(g));
}
static inline void shim_set_drag_handler(ShimDragHandler h) { shim_drag_handler = h; }

static inline void shim_set_col_resize_cursor(GtkWidget *w) {
    GdkCursor *c = gdk_cursor_new_from_name("col-resize", NULL);
    if (c) { gtk_widget_set_cursor(w, c); g_object_unref(c); }
}

/* Smooth width animation on the frame clock (vsync, ease-out cubic).
   Cancels any in-flight animation for the same widget. */
typedef struct { GtkWidget *widget; int start; int target; gint64 t0; int dur_ms; guint tick_id; } ShimWidthAnim;
static gboolean shim_width_tick(GtkWidget *w, GdkFrameClock *clock, gpointer ud) {
    (void)clock;
    ShimWidthAnim *a = (ShimWidthAnim*)ud;
    // If widget was destroyed or a newer anim replaced this one, stop.
    ShimWidthAnim *cur = (ShimWidthAnim*)g_object_get_data(G_OBJECT(w), "shim-width-anim");
    if (cur != a) return G_SOURCE_REMOVE;
    gint64 now = g_get_monotonic_time();
    double p = (double)(now - a->t0) / (double)(a->dur_ms * 1000);
    if (p >= 1.0) {
        gtk_widget_set_size_request(w, a->target, -1);
        if (a->target == 0) gtk_widget_set_visible(w, FALSE);
        g_object_set_data(G_OBJECT(w), "shim-width-anim", NULL);
        // tick_id will be invalid after removal, clear before free
        g_free(a);
        return G_SOURCE_REMOVE;
    }
    double eased = p; // linear — Codex-like, no pause at end
    int width = a->start + (int)((a->target - a->start) * eased);
    gtk_widget_set_size_request(w, width, -1);
    return G_SOURCE_CONTINUE;
}
static inline void shim_animate_width(GtkWidget *w, int start, int target, int dur_ms) {
    // Cancel any in-flight anim
    ShimWidthAnim *old = (ShimWidthAnim*)g_object_get_data(G_OBJECT(w), "shim-width-anim");
    if (old) {
        gtk_widget_remove_tick_callback(w, old->tick_id);
        g_object_set_data(G_OBJECT(w), "shim-width-anim", NULL);
        g_free(old);
    }
    if (target != 0) {
        gtk_widget_set_visible(w, TRUE);
        gtk_widget_set_size_request(w, start, -1);
    }
    ShimWidthAnim *a = g_new0(ShimWidthAnim, 1);
    a->widget = w;
    a->start = start;
    a->target = target;
    a->t0 = g_get_monotonic_time();
    a->dur_ms = dur_ms;
    // Need to know tick_id inside the struct before add, so add then store
    guint id = gtk_widget_add_tick_callback(w, shim_width_tick, a, NULL);
    a->tick_id = id;
    g_object_set_data(G_OBJECT(w), "shim-width-anim", a);
}
static inline void shim_set_overflow_hidden(GtkWidget *w) { gtk_widget_set_overflow(w, GTK_OVERFLOW_HIDDEN); }
static inline void shim_set_halign_start(GtkWidget *w) { gtk_widget_set_halign(w, GTK_ALIGN_START); gtk_widget_set_hexpand(w, FALSE); }
