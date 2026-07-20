import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:t4code/main.dart' as app;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('native shell launches and opens host management', (
    tester,
  ) async {
    await tester.pumpWidget(const app.T4Bootstrap());
    await _pumpUntil(
      tester,
      () =>
          find.byTooltip('Open navigation').evaluate().isNotEmpty ||
          find.byTooltip('Manage hosts').evaluate().isNotEmpty ||
          find.text('Manage hosts').evaluate().isNotEmpty ||
          find.text('Add host').evaluate().isNotEmpty,
    );

    if (find.text('Add host').evaluate().isEmpty) {
      final navigationButton = find.byTooltip('Open navigation');
      if (navigationButton.evaluate().isNotEmpty) {
        await tester.tap(navigationButton);
        await tester.pumpAndSettle();
      }
      final manageHosts = find.text('Manage hosts');
      final manageHostsButton = find.byTooltip('Manage hosts');
      expect(
        manageHosts.evaluate().isNotEmpty ||
            manageHostsButton.evaluate().isNotEmpty,
        isTrue,
      );
      await tester.tap(
        manageHosts.evaluate().isNotEmpty
            ? manageHosts.last
            : manageHostsButton,
      );
      await tester.pumpAndSettle();
    }
    expect(find.text('Add host'), findsOneWidget);
  });
}

Future<void> _pumpUntil(WidgetTester tester, bool Function() predicate) async {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tester.pump(const Duration(milliseconds: 100));
  }
  throw TestFailure('Native shell did not reach host navigation.');
}
