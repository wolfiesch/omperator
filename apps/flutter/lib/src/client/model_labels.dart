// Presentation-only humanization for the in-chat model selector, mirroring the
// Electron/web T4 model picker (apps/web/src/features/settings/settings-presentation.ts).
//
// The host catalog's `name` is the label authority when it names a model; every
// fallback is deterministic so the same input always renders the same words.
// Canonical `provider/modelId` selectors remain the submitted protocol values —
// these helpers NEVER rewrite what is sent to `session.model.set`.

import '../protocol/models.dart';

/// Acronyms kept uppercase when a raw id is humanized for display.
const Map<String, bool> _idAcronyms = <String, bool>{
  'ai': true,
  'api': true,
  'aws': true,
  'cli': true,
  'glm': true,
  'gpt': true,
  'io': true,
  'llm': true,
  'mcp': true,
  'omp': true,
  'qa': true,
  'sdk': true,
  'tts': true,
  'tui': true,
  'ui': true,
  'ux': true,
};

/// `gpt-engineer` → "GPT Engineer", `claude-fable-5` → "Claude Fable 5",
/// `quickTask` → "Quick Task". Split on case changes, hyphens, underscores,
/// and spaces; title-case words; known acronyms go uppercase. Never invents
/// words — a token it can't improve passes through capitalized.
String humanizeIdentifier(String id) {
  // Insert a space before each uppercase letter that follows a lowercase letter
  // or digit (`quickTask` → `quick Task`, `gpt5` → `gpt 5`).
  final camelSplit = id.replaceAllMapped(
    RegExp(r'([a-z0-9])([A-Z])'),
    (Match match) => '${match.group(1)} ${match.group(2)}',
  );
  final words = camelSplit
      .split(RegExp(r'[-_\s]+'))
      .where((word) => word.isNotEmpty)
      .toList(growable: false);
  if (words.isEmpty) return id;
  return words
      .map((String word) {
        final lower = word.toLowerCase();
        if (_idAcronyms[lower] == true) {
          return lower.toUpperCase();
        }
        return word[0].toUpperCase() + word.substring(1);
      })
      .join(' ');
}

/// Friendly names for provider ids OMP routes through. Lowercase keys.
const Map<String, String> _providerNames = <String, String>{
  'anthropic': 'Anthropic',
  'openai': 'OpenAI',
  'google': 'Google',
  'gemini': 'Google',
  'xai': 'xAI',
  'openrouter': 'OpenRouter',
  'github-copilot': 'GitHub Copilot',
  'copilot': 'GitHub Copilot',
  'amazon-bedrock': 'Amazon Bedrock',
  'bedrock': 'Amazon Bedrock',
  'azure-openai': 'Azure OpenAI',
  'azure': 'Azure OpenAI',
};

/// Friendly provider name. Case-insensitive; the longest hyphen-segment prefix
/// wins, so `openai-codex` → "OpenAI", `xai-oauth` → "xAI",
/// `google-vertex` → "Google". Unknown ids humanize deterministically
/// (`ollama` → "Ollama") instead of echoing raw casing.
String providerDisplayName(String id) {
  final segments = id.trim().toLowerCase().split('-');
  for (var end = segments.length; end > 0; end -= 1) {
    final hit = _providerNames[segments.sublist(0, end).join('-')];
    if (hit != null) return hit;
  }
  return humanizeIdentifier(id);
}

/// `provider/modelId` with any trailing `:level` thinking suffix removed.
String baseSelector(String selector) {
  final colon = selector.lastIndexOf(':');
  final slash = selector.indexOf('/');
  return (colon > slash && colon != -1)
      ? selector.substring(0, colon)
      : selector;
}

/// The provider segment of a `provider/modelId` selector, or '' when the
/// selector has no provider.
String providerOf(String selector) {
  final base = baseSelector(selector);
  final slash = base.indexOf('/');
  return slash > 0 ? base.substring(0, slash) : '';
}

/// The model-id segment of a `provider/modelId` selector, or the whole
/// selector when it has no provider.
String modelIdOf(String selector) {
  final base = baseSelector(selector);
  final slash = base.indexOf('/');
  return slash > 0 ? base.substring(slash + 1) : base;
}

/// The last path segment of a model id, humanized for unknown-model fallback.
String _lastSegment(String modelId) {
  final lastSlash = modelId.lastIndexOf('/');
  return lastSlash >= 0 ? modelId.substring(lastSlash + 1) : modelId;
}

/// A resolved display label for one catalog model.
///
/// [label] is the human-facing name (catalog name wins; a miss humanizes the
/// model id's last path segment). [provider] is the raw provider id carried
/// through for grouping; [providerLabel] is its friendly name. The [selector]
/// is the exact `provider/modelId` string submitted to `session.model.set`.
final class ModelLabel {
  const ModelLabel({
    required this.selector,
    required this.label,
    required this.provider,
    required this.providerLabel,
    required this.inCatalog,
  });

  final String selector;
  final String label;
  final String provider;
  final String providerLabel;
  final bool inCatalog;
}

/// Resolve a display label for a catalog model item.
///
/// The catalog `name` wins when it is a human name (not the raw selector);
/// otherwise the model id's last path segment is humanized. The selector is
/// always the exact `provider/modelId` from metadata (or `item.name` when it
/// already contains a slash), carried through untouched as the submitted value.
ModelLabel modelLabelFor(CatalogItem item) {
  final selector = modelItemSelector(item);
  if (selector == null) {
    // No provider/modelId metadata and name has no slash: treat the name as
    // both the label and the selector so the model stays selectable.
    return ModelLabel(
      selector: item.name,
      label: item.name,
      provider: '',
      providerLabel: '',
      inCatalog: true,
    );
  }
  final provider = providerOf(selector);
  final modelId = modelIdOf(selector);
  final catalogName = item.name.trim();
  final labelIsRawSelector =
      catalogName.isEmpty || catalogName == selector || catalogName == modelId;
  final label = labelIsRawSelector
      ? humanizeIdentifier(_lastSegment(modelId))
      : catalogName;
  return ModelLabel(
    selector: selector,
    label: label,
    provider: provider,
    providerLabel: provider.isEmpty ? '' : providerDisplayName(provider),
    inCatalog: true,
  );
}

/// `provider/modelId` from a catalog model item's metadata, guarded.
///
/// Mirrors the web `modelItemSelector`: metadata's `provider`/`modelId` win;
/// a name that already contains a slash is accepted as a selector; otherwise
/// the item does not resolve to a switchable selector.
String? modelItemSelector(CatalogItem item) {
  final metadata = item.metadata;
  if (metadata != null) {
    final provider = metadata['provider'];
    final modelId = metadata['modelId'];
    if (provider is String &&
        provider.isNotEmpty &&
        modelId is String &&
        modelId.isNotEmpty) {
      return '$provider/$modelId';
    }
  }
  return item.name.contains('/') ? item.name : null;
}

/// A provider group for the navigable model menu.
final class ModelProviderGroup {
  const ModelProviderGroup({
    required this.provider,
    required this.label,
    required this.choices,
  });

  /// Raw provider id (empty string for models with no provider).
  final String provider;

  /// Friendly provider name, or 'Other models' when the provider is unknown.
  final String label;

  /// Choices within this group, ordered by label.
  final List<ResolvedModelChoice> choices;
}

/// A model choice with its resolved display label and raw selector.
final class ResolvedModelChoice {
  const ResolvedModelChoice({
    required this.selector,
    required this.label,
    required this.provider,
    required this.providerLabel,
    required this.supported,
    required this.reason,
  });

  /// Exact `provider/modelId` submitted to `session.model.set`.
  final String selector;

  /// Human-facing model name.
  final String label;

  /// Raw provider id (empty when none).
  final String provider;

  /// Friendly provider name (empty when none).
  final String providerLabel;

  final bool supported;
  final String? reason;
}

/// Group catalog model choices by provider for a navigable selector.
///
/// Known providers are ordered by friendly name; an unknown/empty provider
/// bucket ('Other models') sorts last so it never hides known providers.
/// Within a group, choices sort by label. Duplicate selectors collapse to the
/// first occurrence. Unsupported models are retained but marked, so they stay
/// selectable (and the host can explain why) rather than silently disappearing.
List<ModelProviderGroup> groupModelChoices(Iterable<CatalogItem> catalog) {
  final seen = <String>{};
  final byProvider = <String, List<ResolvedModelChoice>>{};
  for (final item in catalog) {
    if (item.kind != 'model') continue;
    final selector = modelItemSelector(item);
    if (selector == null || !seen.add(selector)) continue;
    final label = modelLabelFor(item);
    byProvider
        .putIfAbsent(label.provider, () => <ResolvedModelChoice>[])
        .add(
          ResolvedModelChoice(
            selector: label.selector,
            label: label.label,
            provider: label.provider,
            providerLabel: label.providerLabel,
            supported: item.supported != false,
            reason: item.reason,
          ),
        );
  }
  final groups = <ModelProviderGroup>[];
  for (final entry in byProvider.entries) {
    entry.value.sort((a, b) => a.label.compareTo(b.label));
    groups.add(
      ModelProviderGroup(
        provider: entry.key,
        label: entry.key.isEmpty
            ? 'Other models'
            : (entry.value.first.providerLabel.isEmpty
                  ? 'Other models'
                  : entry.value.first.providerLabel),
        choices: List<ResolvedModelChoice>.unmodifiable(entry.value),
      ),
    );
  }
  // Known providers alphabetical by friendly label; 'Other models' last.
  groups.sort((a, b) {
    final aOther = a.provider.isEmpty;
    final bOther = b.provider.isEmpty;
    if (aOther != bOther) return aOther ? 1 : -1;
    return a.label.compareTo(b.label);
  });
  return List<ModelProviderGroup>.unmodifiable(groups);
}

/// Resolve a human-facing label for a session's current model selector.
///
/// Catalog labels win; a selector that matches no catalog entry humanizes its
/// model id's last path segment so unknown models still read as a name rather
/// than a raw `provider/modelId` id. The raw selector is returned unchanged as
/// the submitted value. Returns null when the session has no model selector.
String? sessionModelLabel(
  String? selector,
  String? displayName,
  Iterable<CatalogItem> catalog,
) {
  if (selector == null || selector.isEmpty) {
    return displayName;
  }
  if (displayName != null && displayName.trim().isNotEmpty) {
    return displayName;
  }
  final base = baseSelector(selector);
  for (final item in catalog) {
    if (item.kind != 'model') continue;
    final itemSelector = modelItemSelector(item);
    if (itemSelector == null) continue;
    if (baseSelector(itemSelector) == base) {
      final label = modelLabelFor(item);
      return label.label;
    }
  }
  // Unknown selector: humanize the model id's last path segment.
  final modelId = modelIdOf(selector);
  return humanizeIdentifier(_lastSegment(modelId));
}
