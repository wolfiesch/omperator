#include <webkit/webkit.h>

/* T4BoundedBox: a GtkBox that reports a zero natural size and gives its
 * child the box's full allocation. WebKitWebView's natural size request is
 * the page's laid-out size, which otherwise propagates through SwiftCrossUI's
 * GtkFixed containers and inflates the whole window layout. With the natural
 * size capped, the host layout decides the webview's size and the page lays
 * out responsively at that size.
 *
 * Header-only: everything is static; the type registers lazily on first use.
 */

typedef struct {
    GtkBox parent;
} T4BoundedBox;

typedef struct {
    GtkBoxClass parent_class;
} T4BoundedBoxClass;

static void t4_bounded_box_measure(
    GtkWidget *widget,
    GtkOrientation orientation,
    int for_size,
    int *minimum,
    int *natural,
    int *minimum_baseline,
    int *natural_baseline
) {
    (void)widget;
    (void)orientation;
    (void)for_size;
    /* A modest fixed request: zero naturals let the webview hit a transient
       zero-size allocation before SwiftCrossUI's size request lands, and
       WebKitGTK stops presenting for good. */
    if (minimum) *minimum = 64;
    if (natural) *natural = 64;
    if (minimum_baseline) *minimum_baseline = -1;
    if (natural_baseline) *natural_baseline = -1;
}

static void t4_bounded_box_class_init(T4BoundedBoxClass *klass) {
    GTK_WIDGET_CLASS(klass)->measure = t4_bounded_box_measure;
}

static void t4_bounded_box_init(T4BoundedBox *self) {
    (void)self;
}

static GType t4_bounded_box_get_type(void) {
    static GType type = 0;
    if (type == 0) {
        const GTypeInfo info = {
            sizeof(T4BoundedBoxClass),
            NULL,
            NULL,
            (GClassInitFunc)t4_bounded_box_class_init,
            NULL,
            NULL,
            sizeof(T4BoundedBox),
            0,
            (GInstanceInitFunc)t4_bounded_box_init,
            NULL
        };
        type = g_type_register_static(GTK_TYPE_BOX, "T4BoundedBox", &info, 0);
    }
    return type;
}

/// Create a bounded box containing a fresh WebKitWebView. Returns the box;
/// the webview is its (only) child, retrievable with
/// gtk_widget_get_first_child().
static GtkWidget *t4_bounded_web_view_box_new(void) {
    GtkWidget *box = GTK_WIDGET(g_object_new(t4_bounded_box_get_type(), NULL));
    gtk_orientable_set_orientation(GTK_ORIENTABLE(box), GTK_ORIENTATION_HORIZONTAL);
    GtkWidget *web_view = webkit_web_view_new();
    gtk_widget_set_hexpand(web_view, TRUE);
    gtk_widget_set_vexpand(web_view, TRUE);
    gtk_widget_set_parent(web_view, box);
    return box;
}
