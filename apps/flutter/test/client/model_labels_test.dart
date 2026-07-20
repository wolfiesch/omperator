import 'package:flutter_test/flutter_test.dart';
import 'package:t4code/src/client/model_labels.dart';
import 'package:t4code/src/protocol/models.dart';

void main() {
  group('humanizeIdentifier', () {
    test('splits camelCase, hyphens, underscores and title-cases words', () {
      expect(humanizeIdentifier('gpt-engineer'), 'GPT Engineer');
      expect(humanizeIdentifier('claude-fable-5'), 'Claude Fable 5');
      expect(humanizeIdentifier('quickTask'), 'Quick Task');
      expect(humanizeIdentifier('gemini_3_flash'), 'Gemini 3 Flash');
    });

    test('keeps known acronyms uppercase', () {
      expect(humanizeIdentifier('gpt-5-6-sol'), 'GPT 5 6 Sol');
      expect(humanizeIdentifier('glm-4-api'), 'GLM 4 API');
    });

    test('passes through unimprovable tokens capitalized', () {
      expect(humanizeIdentifier('ollama'), 'Ollama');
      expect(humanizeIdentifier('mistral'), 'Mistral');
    });
  });

  group('providerDisplayName', () {
    test('maps known providers to friendly names', () {
      expect(providerDisplayName('anthropic'), 'Anthropic');
      expect(providerDisplayName('openai'), 'OpenAI');
      expect(providerDisplayName('openai-codex'), 'OpenAI');
      expect(providerDisplayName('xai-oauth'), 'xAI');
      expect(providerDisplayName('google-vertex'), 'Google');
      expect(providerDisplayName('github-copilot'), 'GitHub Copilot');
    });

    test('humanizes unknown providers deterministically', () {
      expect(providerDisplayName('ollama'), 'Ollama');
      expect(providerDisplayName('together-ai'), 'Together AI');
    });
  });

  group('modelItemSelector', () {
    test('builds provider/modelId from metadata', () {
      final item = _catalogItem(
        kind: 'model',
        name: 'GPT-5.6 Sol',
        metadata: <String, Object?>{
          'provider': 'openai-codex',
          'modelId': 'gpt-5.6-sol',
        },
      );
      expect(modelItemSelector(item), 'openai-codex/gpt-5.6-sol');
    });

    test('falls back to name when it contains a slash', () {
      final item = _catalogItem(
        kind: 'model',
        name: 'anthropic/claude-fable-5',
        metadata: null,
      );
      expect(modelItemSelector(item), 'anthropic/claude-fable-5');
    });

    test('returns null when no provider/modelId and name has no slash', () {
      final item = _catalogItem(
        kind: 'model',
        name: 'claude-fable-5',
        metadata: null,
      );
      expect(modelItemSelector(item), isNull);
    });
  });

  group('modelLabelFor', () {
    test('uses catalog name when it is a human label', () {
      final item = _catalogItem(
        kind: 'model',
        name: 'GPT-5.6 Sol',
        metadata: <String, Object?>{
          'provider': 'openai-codex',
          'modelId': 'gpt-5.6-sol',
        },
      );
      final label = modelLabelFor(item);
      expect(label.selector, 'openai-codex/gpt-5.6-sol');
      expect(label.label, 'GPT-5.6 Sol');
      expect(label.provider, 'openai-codex');
      expect(label.providerLabel, 'OpenAI');
      expect(label.inCatalog, isTrue);
    });

    test('humanizes the model id when the catalog name equals the raw id', () {
      final item = _catalogItem(
        kind: 'model',
        name: 'openai-codex/gpt-5.6-sol',
        metadata: <String, Object?>{
          'provider': 'openai-codex',
          'modelId': 'gpt-5.6-sol',
        },
      );
      final label = modelLabelFor(item);
      expect(label.selector, 'openai-codex/gpt-5.6-sol');
      expect(label.label, 'GPT 5.6 Sol');
      expect(label.providerLabel, 'OpenAI');
    });

    test('raw protocol id never leaks as the primary known-model label', () {
      final item = _catalogItem(
        kind: 'model',
        name: 'openai-codex/gpt-5.6-sol',
        metadata: <String, Object?>{
          'provider': 'openai-codex',
          'modelId': 'gpt-5.6-sol',
        },
      );
      final label = modelLabelFor(item);
      expect(label.label, isNot(equals(label.selector)));
      expect(label.label, isNot(contains('/')));
    });
  });

  group('groupModelChoices', () {
    test('groups models by provider with friendly provider labels', () {
      final catalog = <CatalogItem>[
        _catalogItem(
          kind: 'model',
          name: 'GPT-5.6 Sol',
          metadata: <String, Object?>{
            'provider': 'openai-codex',
            'modelId': 'gpt-5.6-sol',
          },
        ),
        _catalogItem(
          kind: 'model',
          name: 'GPT-5.6',
          metadata: <String, Object?>{
            'provider': 'openai-codex',
            'modelId': 'gpt-5.6',
          },
        ),
        _catalogItem(
          kind: 'model',
          name: 'Claude Fable 5',
          metadata: <String, Object?>{
            'provider': 'anthropic',
            'modelId': 'claude-fable-5',
          },
        ),
      ];
      final groups = groupModelChoices(catalog);
      expect(groups, hasLength(2));
      // Known providers sort alphabetically by friendly label.
      expect(groups.first.label, 'Anthropic');
      expect(groups.first.choices, hasLength(1));
      expect(groups.first.choices.single.label, 'Claude Fable 5');
      expect(groups.last.label, 'OpenAI');
      expect(groups.last.choices, hasLength(2));
      // Within a group, choices sort by label.
      expect(groups.last.choices.first.label, 'GPT-5.6');
      expect(groups.last.choices.last.label, 'GPT-5.6 Sol');
    });

    test('collapses duplicate selectors to the first occurrence', () {
      final catalog = <CatalogItem>[
        _catalogItem(
          kind: 'model',
          name: 'GPT-5.6 Sol',
          metadata: <String, Object?>{
            'provider': 'openai-codex',
            'modelId': 'gpt-5.6-sol',
          },
        ),
        _catalogItem(
          kind: 'model',
          name: 'Duplicate',
          metadata: <String, Object?>{
            'provider': 'openai-codex',
            'modelId': 'gpt-5.6-sol',
          },
        ),
      ];
      final groups = groupModelChoices(catalog);
      expect(groups, hasLength(1));
      expect(groups.single.choices, hasLength(1));
      expect(groups.single.choices.single.label, 'GPT-5.6 Sol');
    });

    test('unknown providers sort after known providers', () {
      final catalog = <CatalogItem>[
        _catalogItem(
          kind: 'model',
          name: 'Claude Fable 5',
          metadata: <String, Object?>{
            'provider': 'anthropic',
            'modelId': 'claude-fable-5',
          },
        ),
        _catalogItem(
          kind: 'model',
          name: 'Mistral Large',
          metadata: <String, Object?>{
            'provider': 'mistral',
            'modelId': 'large',
          },
        ),
      ];
      final groups = groupModelChoices(catalog);
      expect(groups, hasLength(2));
      expect(groups.first.label, 'Anthropic');
      expect(groups.last.label, 'Mistral');
      expect(groups.last.choices.single.selector, 'mistral/large');
    });

    test('models that cannot resolve to a selector are dropped safely', () {
      final catalog = <CatalogItem>[
        _catalogItem(kind: 'model', name: 'local-model', metadata: null),
        _catalogItem(
          kind: 'model',
          name: 'anthropic/claude-fable-5',
          metadata: null,
        ),
      ];
      final groups = groupModelChoices(catalog);
      // The slash-less name with no metadata cannot resolve to a switchable
      // selector, so it is dropped rather than offered as a non-functional
      // choice. The slash-named model still resolves and groups under Anthropic.
      expect(groups, hasLength(1));
      expect(groups.single.label, 'Anthropic');
      expect(groups.single.choices.single.selector, 'anthropic/claude-fable-5');
    });

    test('ignores non-model catalog items', () {
      final catalog = <CatalogItem>[
        _catalogItem(kind: 'command', name: '/model', metadata: null),
        _catalogItem(
          kind: 'model',
          name: 'GPT-5.6 Sol',
          metadata: <String, Object?>{
            'provider': 'openai-codex',
            'modelId': 'gpt-5.6-sol',
          },
        ),
      ];
      final groups = groupModelChoices(catalog);
      expect(groups, hasLength(1));
      expect(groups.single.choices, hasLength(1));
    });

    test('retains unsupported models as selectable but marked', () {
      final catalog = <CatalogItem>[
        _catalogItem(
          kind: 'model',
          name: 'GPT-5.6 Sol',
          supported: false,
          reason: 'No API key',
          metadata: <String, Object?>{
            'provider': 'openai-codex',
            'modelId': 'gpt-5.6-sol',
          },
        ),
      ];
      final groups = groupModelChoices(catalog);
      expect(groups.single.choices.single.supported, isFalse);
      expect(groups.single.choices.single.reason, 'No API key');
      // Selector is still present so the model stays selectable.
      expect(groups.single.choices.single.selector, 'openai-codex/gpt-5.6-sol');
    });
  });

  group('sessionModelLabel', () {
    final catalog = <CatalogItem>[
      _catalogItem(
        kind: 'model',
        name: 'GPT-5.6 Sol',
        metadata: <String, Object?>{
          'provider': 'openai-codex',
          'modelId': 'gpt-5.6-sol',
        },
      ),
    ];

    test('prefers the host-reported display name', () {
      expect(
        sessionModelLabel('openai-codex/gpt-5.6-sol', 'GPT-5.6 Sol', catalog),
        'GPT-5.6 Sol',
      );
    });

    test('falls back to the catalog label when display name is absent', () {
      expect(
        sessionModelLabel('openai-codex/gpt-5.6-sol', null, catalog),
        'GPT-5.6 Sol',
      );
    });

    test('humanizes an unknown selector so the raw id never shows', () {
      expect(
        sessionModelLabel('unknown-vendor/some-model-7', null, catalog),
        'Some Model 7',
      );
    });

    test('returns the display name when selector is null', () {
      expect(sessionModelLabel(null, 'Host model', catalog), 'Host model');
    });

    test('returns null when both selector and display name are absent', () {
      expect(sessionModelLabel(null, null, catalog), isNull);
    });

    test('strips a trailing thinking-level suffix before matching', () {
      expect(
        sessionModelLabel('openai-codex/gpt-5.6-sol:high', null, catalog),
        'GPT-5.6 Sol',
      );
    });
  });

  group('submission of the unchanged raw id', () {
    test('groupModelChoices carries the exact provider/modelId selector', () {
      final catalog = <CatalogItem>[
        _catalogItem(
          kind: 'model',
          name: 'GPT-5.6 Sol',
          metadata: <String, Object?>{
            'provider': 'openai-codex',
            'modelId': 'gpt-5.6-sol',
          },
        ),
      ];
      final groups = groupModelChoices(catalog);
      // The submitted value is the raw protocol id, not the humanized label.
      expect(groups.single.choices.single.selector, 'openai-codex/gpt-5.6-sol');
      expect(
        groups.single.choices.single.selector,
        isNot(equals(groups.single.choices.single.label)),
      );
    });

    test('modelLabelFor never rewrites the selector', () {
      final item = _catalogItem(
        kind: 'model',
        name: 'GPT-5.6 Sol',
        metadata: <String, Object?>{
          'provider': 'openai-codex',
          'modelId': 'gpt-5.6-sol',
        },
      );
      final label = modelLabelFor(item);
      expect(label.selector, 'openai-codex/gpt-5.6-sol');
      expect(label.label, 'GPT-5.6 Sol');
      // The human label and the submitted selector are distinct values.
      expect(label.label, isNot(equals(label.selector)));
    });
  });
}

CatalogItem _catalogItem({
  required String kind,
  required String name,
  Map<String, Object?>? metadata,
  bool? supported,
  String? reason,
}) {
  final raw = <String, Object?>{
    'id': '$kind-$name',
    'kind': kind,
    'name': name,
    'description': null,
    'capabilities': null,
    'supported': supported,
    'reason': reason,
    'metadata': metadata,
  };
  return CatalogItem(
    id: '$kind-$name',
    kind: kind,
    name: name,
    description: null,
    capabilities: null,
    supported: supported,
    reason: reason,
    metadata: metadata,
    raw: raw,
  );
}
