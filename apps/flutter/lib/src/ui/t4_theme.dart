part of 't4_app.dart';

abstract final class _T4Breakpoints {
  static const double wide = 980;
}

abstract final class _T4Layout {
  static const double sessionRailWidth = 300;
  static const double contentMaxWidth = 760;
  static const double compactToolbarHeight = 72;
  static const double minimumTouchTarget = 44;
  static const double followScrollThreshold = 96;
}

abstract final class _T4Space {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
}

abstract final class _T4Radius {
  static const double xs = 6;
  static const double sm = 8;
  static const double md = 10;
  static const double lg = 16;
}

abstract final class _T4Size {
  static const double indicator = 16;
  static const double emptyIcon = 32;
  static const double thinStroke = 2;
  static const double divider = 1;
}

abstract final class _T4Motion {
  static const Duration short = Duration(milliseconds: 120);
  static const Curve standard = Curves.easeOut;
}

abstract final class _T4Typography {
  static const String sansFamily = 'DM Sans';
  static const String monoFamily = 'JetBrains Mono';
}

/// Semantic T4 colors that do not map cleanly onto Material's color roles.
///
/// These values mirror `packages/ui/src/tokens.css`; widgets consume this
/// extension instead of defining platform-specific colors.
@immutable
final class T4SemanticColors extends ThemeExtension<T4SemanticColors> {
  const T4SemanticColors({
    required this.brand,
    required this.accentText,
    required this.info,
    required this.infoForeground,
    required this.success,
    required this.successForeground,
    required this.warning,
    required this.warningForeground,
    required this.statusWorking,
    required this.statusApproval,
    required this.statusInput,
    required this.statusPlan,
    required this.statusDone,
    required this.statusError,
  });

  final Color brand;
  final Color accentText;
  final Color info;
  final Color infoForeground;
  final Color success;
  final Color successForeground;
  final Color warning;
  final Color warningForeground;
  final Color statusWorking;
  final Color statusApproval;
  final Color statusInput;
  final Color statusPlan;
  final Color statusDone;
  final Color statusError;

  static T4SemanticColors of(BuildContext context) =>
      Theme.of(context).extension<T4SemanticColors>()!;

  @override
  T4SemanticColors copyWith({
    Color? brand,
    Color? accentText,
    Color? info,
    Color? infoForeground,
    Color? success,
    Color? successForeground,
    Color? warning,
    Color? warningForeground,
    Color? statusWorking,
    Color? statusApproval,
    Color? statusInput,
    Color? statusPlan,
    Color? statusDone,
    Color? statusError,
  }) => T4SemanticColors(
    brand: brand ?? this.brand,
    accentText: accentText ?? this.accentText,
    info: info ?? this.info,
    infoForeground: infoForeground ?? this.infoForeground,
    success: success ?? this.success,
    successForeground: successForeground ?? this.successForeground,
    warning: warning ?? this.warning,
    warningForeground: warningForeground ?? this.warningForeground,
    statusWorking: statusWorking ?? this.statusWorking,
    statusApproval: statusApproval ?? this.statusApproval,
    statusInput: statusInput ?? this.statusInput,
    statusPlan: statusPlan ?? this.statusPlan,
    statusDone: statusDone ?? this.statusDone,
    statusError: statusError ?? this.statusError,
  );

  @override
  T4SemanticColors lerp(covariant T4SemanticColors? other, double t) {
    if (other == null) return this;
    return T4SemanticColors(
      brand: Color.lerp(brand, other.brand, t)!,
      accentText: Color.lerp(accentText, other.accentText, t)!,
      info: Color.lerp(info, other.info, t)!,
      infoForeground: Color.lerp(infoForeground, other.infoForeground, t)!,
      success: Color.lerp(success, other.success, t)!,
      successForeground: Color.lerp(
        successForeground,
        other.successForeground,
        t,
      )!,
      warning: Color.lerp(warning, other.warning, t)!,
      warningForeground: Color.lerp(
        warningForeground,
        other.warningForeground,
        t,
      )!,
      statusWorking: Color.lerp(statusWorking, other.statusWorking, t)!,
      statusApproval: Color.lerp(statusApproval, other.statusApproval, t)!,
      statusInput: Color.lerp(statusInput, other.statusInput, t)!,
      statusPlan: Color.lerp(statusPlan, other.statusPlan, t)!,
      statusDone: Color.lerp(statusDone, other.statusDone, t)!,
      statusError: Color.lerp(statusError, other.statusError, t)!,
    );
  }
}

abstract final class _T4Palette {
  static const Color brand = Color(0xffe83174);

  static const ColorScheme lightScheme = ColorScheme(
    brightness: Brightness.light,
    primary: Color(0xffb8245b),
    onPrimary: Color(0xffffffff),
    primaryContainer: Color(0xfff8e9ef),
    onPrimaryContainer: Color(0xffb8245b),
    secondary: Color(0xfff5f5f5),
    onSecondary: Color(0xff262626),
    secondaryContainer: Color(0xfff5f5f5),
    onSecondaryContainer: Color(0xff262626),
    tertiary: Color(0xff1447e6),
    onTertiary: Color(0xffffffff),
    tertiaryContainer: Color(0xffedf2fc),
    onTertiaryContainer: Color(0xff1447e6),
    error: Color(0xfffb2c36),
    onError: Color(0xffffffff),
    errorContainer: Color(0xffffe9ea),
    onErrorContainer: Color(0xffc10007),
    surface: Color(0xffffffff),
    onSurface: Color(0xff262626),
    surfaceDim: Color(0xfff5f5f5),
    surfaceBright: Color(0xffffffff),
    surfaceContainerLowest: Color(0xffffffff),
    surfaceContainerLow: Color(0xfffafafa),
    surfaceContainer: Color(0xfff5f5f5),
    surfaceContainerHigh: Color(0xfff0f0f0),
    surfaceContainerHighest: Color(0xffe8e8e8),
    onSurfaceVariant: Color(0xff696969),
    outline: Color(0x1a000000),
    outlineVariant: Color(0x14000000),
    shadow: Color(0x1a000000),
    scrim: Color(0x66000000),
    inverseSurface: Color(0xff262626),
    onInverseSurface: Color(0xfff5f5f5),
    inversePrimary: Color(0xfff67399),
  );

  static const T4SemanticColors lightSemantic = T4SemanticColors(
    brand: brand,
    accentText: Color(0xffb8245b),
    info: Color(0xff2b7fff),
    infoForeground: Color(0xff1447e6),
    success: Color(0xff00bc7d),
    successForeground: Color(0xff007a55),
    warning: Color(0xfffe9a00),
    warningForeground: Color(0xffbb4d00),
    statusWorking: Color(0xff0084d1),
    statusApproval: Color(0xffe17100),
    statusInput: Color(0xff4f39f6),
    statusPlan: Color(0xff7f22fe),
    statusDone: Color(0xff009966),
    statusError: Color(0xffe7000b),
  );

  static const ColorScheme darkScheme = ColorScheme(
    brightness: Brightness.dark,
    primary: Color(0xfff67399),
    onPrimary: Color(0xff0a0a0a),
    primaryContainer: Color(0xff3a252b),
    onPrimaryContainer: Color(0xfffc93ae),
    secondary: Color(0xff1f1f1f),
    onSecondary: Color(0xfff5f5f5),
    secondaryContainer: Color(0xff1f1f1f),
    onSecondaryContainer: Color(0xfff5f5f5),
    tertiary: Color(0xff51a2ff),
    onTertiary: Color(0xff0a0a0a),
    tertiaryContainer: Color(0xff1f2d42),
    onTertiaryContainer: Color(0xff51a2ff),
    error: Color(0xfffc414a),
    onError: Color(0xffffffff),
    errorContainer: Color(0xff3b1d1f),
    onErrorContainer: Color(0xffff6467),
    surface: Color(0xff161616),
    onSurface: Color(0xfff5f5f5),
    surfaceDim: Color(0xff0a0a0a),
    surfaceBright: Color(0xff292929),
    surfaceContainerLowest: Color(0xff1b1b1b),
    surfaceContainerLow: Color(0xff1f1f1f),
    surfaceContainer: Color(0xff1f1f1f),
    surfaceContainerHigh: Color(0xff242424),
    surfaceContainerHighest: Color(0xff292929),
    onSurfaceVariant: Color(0xffa1a1a1),
    outline: Color(0x14ffffff),
    outlineVariant: Color(0x0fffffff),
    shadow: Color(0x80000000),
    scrim: Color(0x99000000),
    inverseSurface: Color(0xfff5f5f5),
    onInverseSurface: Color(0xff262626),
    inversePrimary: Color(0xffb8245b),
  );

  static const T4SemanticColors darkSemantic = T4SemanticColors(
    brand: brand,
    accentText: Color(0xfffc93ae),
    info: Color(0xff2b7fff),
    infoForeground: Color(0xff51a2ff),
    success: Color(0xff00bc7d),
    successForeground: Color(0xff00d492),
    warning: Color(0xfffe9a00),
    warningForeground: Color(0xffffb900),
    statusWorking: Color(0xff00a6f4),
    statusApproval: Color(0xffffb900),
    statusInput: Color(0xff7c6cff),
    statusPlan: Color(0xffa970ff),
    statusDone: Color(0xff00d492),
    statusError: Color(0xffff6467),
  );
}

abstract final class _T4Theme {
  static ThemeData light() => _build(
    scheme: _T4Palette.lightScheme,
    semantic: _T4Palette.lightSemantic,
  );

  static ThemeData dark() =>
      _build(scheme: _T4Palette.darkScheme, semantic: _T4Palette.darkSemantic);

  static ThemeData _build({
    required ColorScheme scheme,
    required T4SemanticColors semantic,
  }) {
    final base = ThemeData(
      useMaterial3: true,
      brightness: scheme.brightness,
      colorScheme: scheme,
      fontFamily: _T4Typography.sansFamily,
    );
    final textTheme = base.textTheme
        .apply(
          fontFamily: _T4Typography.sansFamily,
          bodyColor: scheme.onSurface,
          displayColor: scheme.onSurface,
        )
        .copyWith(
          headlineSmall: base.textTheme.headlineSmall?.copyWith(
            fontFamily: _T4Typography.sansFamily,
            fontWeight: FontWeight.w600,
          ),
          titleLarge: base.textTheme.titleLarge?.copyWith(
            fontFamily: _T4Typography.sansFamily,
            fontWeight: FontWeight.w600,
          ),
          titleMedium: base.textTheme.titleMedium?.copyWith(
            fontFamily: _T4Typography.sansFamily,
            fontWeight: FontWeight.w600,
          ),
          titleSmall: base.textTheme.titleSmall?.copyWith(
            fontFamily: _T4Typography.sansFamily,
            fontWeight: FontWeight.w600,
          ),
          labelLarge: base.textTheme.labelLarge?.copyWith(
            fontFamily: _T4Typography.sansFamily,
            fontWeight: FontWeight.w500,
          ),
          labelMedium: base.textTheme.labelMedium?.copyWith(
            fontFamily: _T4Typography.sansFamily,
            fontWeight: FontWeight.w500,
          ),
          labelSmall: base.textTheme.labelSmall?.copyWith(
            fontFamily: _T4Typography.sansFamily,
            fontWeight: FontWeight.w500,
            letterSpacing: 0.3,
          ),
        );
    final minimumSize = WidgetStatePropertyAll<Size>(
      Size.square(_T4Layout.minimumTouchTarget),
    );
    final controlShape = WidgetStatePropertyAll<OutlinedBorder>(
      RoundedRectangleBorder(borderRadius: BorderRadius.circular(_T4Radius.md)),
    );
    final controlPadding = WidgetStatePropertyAll<EdgeInsetsGeometry>(
      const EdgeInsets.symmetric(horizontal: 12),
    );

    return base.copyWith(
      scaffoldBackgroundColor: scheme.surface,
      textTheme: textTheme,
      visualDensity: VisualDensity.standard,
      extensions: <ThemeExtension<dynamic>>[semantic],
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        titleTextStyle: textTheme.titleMedium,
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        space: _T4Size.divider,
        thickness: _T4Size.divider,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerLowest,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: _T4Space.md,
          vertical: _T4Space.sm,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          borderSide: BorderSide(color: scheme.outline),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          borderSide: BorderSide(color: scheme.outline),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          borderSide: BorderSide(
            color: scheme.primary,
            width: _T4Size.thinStroke,
          ),
        ),
        disabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        floatingLabelStyle: TextStyle(color: scheme.primary),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: ButtonStyle(
          minimumSize: minimumSize,
          shape: controlShape,
          padding: controlPadding,
          elevation: const WidgetStatePropertyAll<double>(0),
          textStyle: WidgetStatePropertyAll<TextStyle?>(textTheme.labelLarge),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: ButtonStyle(
          minimumSize: minimumSize,
          shape: controlShape,
          padding: controlPadding,
          side: WidgetStatePropertyAll<BorderSide>(
            BorderSide(color: scheme.outline),
          ),
          textStyle: WidgetStatePropertyAll<TextStyle?>(textTheme.labelLarge),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: ButtonStyle(
          minimumSize: minimumSize,
          shape: controlShape,
          padding: controlPadding,
          textStyle: WidgetStatePropertyAll<TextStyle?>(textTheme.labelLarge),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: ButtonStyle(minimumSize: minimumSize, shape: controlShape),
      ),
      cardTheme: CardThemeData(
        color: scheme.surfaceContainerLowest,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.md),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      dialogTheme: DialogThemeData(
        backgroundColor: scheme.surfaceContainerLowest,
        surfaceTintColor: Colors.transparent,
        elevation: 16,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.lg),
          side: BorderSide(color: scheme.outlineVariant),
        ),
        titleTextStyle: textTheme.headlineSmall,
        contentTextStyle: textTheme.bodyMedium,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surfaceContainerLowest,
        modalBackgroundColor: scheme.surfaceContainerLowest,
        surfaceTintColor: Colors.transparent,
        elevation: 16,
        modalElevation: 16,
        shape: RoundedRectangleBorder(
          borderRadius: const BorderRadius.vertical(
            top: Radius.circular(_T4Radius.lg),
          ),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: scheme.surfaceContainer,
        selectedColor: scheme.primaryContainer,
        disabledColor: scheme.surfaceContainer,
        side: BorderSide(color: scheme.outlineVariant),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.xs),
        ),
        labelStyle: textTheme.labelMedium,
        padding: const EdgeInsets.symmetric(horizontal: _T4Space.xs),
      ),
      listTileTheme: ListTileThemeData(
        minTileHeight: _T4Layout.minimumTouchTarget,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
        iconColor: scheme.onSurfaceVariant,
      ),
      drawerTheme: DrawerThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(),
      ),
      navigationDrawerTheme: NavigationDrawerThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: scheme.primaryContainer,
        indicatorShape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: scheme.surfaceContainerLowest,
        surfaceTintColor: Colors.transparent,
        elevation: 8,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.sm),
          side: BorderSide(color: scheme.outlineVariant),
        ),
        textStyle: textTheme.bodyMedium,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onInverseSurface,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
      ),
      tooltipTheme: TooltipThemeData(
        waitDuration: _T4Motion.short,
        decoration: BoxDecoration(
          color: scheme.inverseSurface,
          borderRadius: BorderRadius.circular(_T4Radius.sm),
        ),
        textStyle: textTheme.labelSmall?.copyWith(
          color: scheme.onInverseSurface,
        ),
      ),
      scrollbarTheme: ScrollbarThemeData(
        radius: const Radius.circular(3),
        thickness: const WidgetStatePropertyAll<double>(6),
        thumbColor: WidgetStateProperty.resolveWith<Color?>(
          (states) => states.contains(WidgetState.hovered)
              ? scheme.onSurface.withValues(alpha: 0.25)
              : scheme.onSurface.withValues(alpha: 0.15),
        ),
      ),
      textSelectionTheme: TextSelectionThemeData(
        cursorColor: scheme.primary,
        selectionColor: scheme.primary.withValues(alpha: 0.22),
        selectionHandleColor: scheme.primary,
      ),
      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: scheme.primary,
        linearTrackColor: scheme.surfaceContainerHighest,
        circularTrackColor: scheme.surfaceContainerHighest,
      ),
    );
  }
}
