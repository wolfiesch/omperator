import 'package:shared_preferences/shared_preferences.dart';

const String appThemePreferenceKey = 't4-code:theme-preference:v1';

abstract interface class AppPreferenceStore {
  Future<String?> loadThemePreference();

  Future<void> saveThemePreference(String value);
}

final class InMemoryAppPreferenceStore implements AppPreferenceStore {
  InMemoryAppPreferenceStore({this.themePreference});

  String? themePreference;

  @override
  Future<String?> loadThemePreference() async => themePreference;

  @override
  Future<void> saveThemePreference(String value) async {
    themePreference = value;
  }
}

final class PersistentAppPreferenceStore implements AppPreferenceStore {
  PersistentAppPreferenceStore({SharedPreferencesAsync? preferences})
    : _preferences = preferences ?? SharedPreferencesAsync();

  final SharedPreferencesAsync _preferences;

  @override
  Future<String?> loadThemePreference() =>
      _preferences.getString(appThemePreferenceKey);

  @override
  Future<void> saveThemePreference(String value) =>
      _preferences.setString(appThemePreferenceKey, value);
}
