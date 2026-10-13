import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:hive/hive.dart';

class RawRecord {
  final int typeId;
  final Map<String, dynamic> fields;
  RawRecord(this.typeId, this.fields);
}

class RawAdapter extends TypeAdapter<RawRecord> {
  @override
  final int typeId;
  RawAdapter(this.typeId);
  @override
  RawRecord read(BinaryReader reader) {
    final count = reader.readByte();
    final fields = <String, dynamic>{};
    for (var index = 0; index < count; index++) {
      final field = reader.readByte();
      if (fields.containsKey('$field')) throw StateError('Duplicate field');
      fields['$field'] = reader.read();
    }
    return RawRecord(typeId, fields);
  }
  @override
  void write(BinaryWriter writer, RawRecord value) => throw UnsupportedError('read-only');
}

dynamic encodeValue(dynamic value) {
  if (value is RawRecord) return {'typeId': value.typeId, 'fields': value.fields.map((k, v) => MapEntry(k, encodeValue(v)))};
  if (value is DateTime) return {'dateTime': value.toUtc().toIso8601String(), 'microsecondsSinceEpoch': value.microsecondsSinceEpoch, 'isUtc': value.isUtc};
  if (value is Uint8List) return {'binaryBase64': base64Encode(value)};
  if (value is List) return value.map(encodeValue).toList();
  if (value is Map) return {'mapEntries': value.entries.map((entry) => [encodeValue(entry.key), encodeValue(entry.value)]).toList()};
  if (value == null || value is String || value is num || value is bool) return value;
  throw UnsupportedError('Unsupported Hive value');
}

void main() {
  runZonedGuarded(exportBoxes, (_, __) {
    stderr.write('Hive 兼容读取失败，源数据未修改。');
    exitCode = 1;
  });
}

Future<void> exportBoxes() async {
  try {
    final input = jsonDecode(await stdin.transform(utf8.decoder).join()) as Map<String, dynamic>;
    final hive = Hive;
    for (var id = 0; id < 4; id++) { hive.registerAdapter(RawAdapter(id)); }
    final result = <String, dynamic>{};
    for (final name in ['global_config', 'workspaces', 'skills', 'downstream_mcps']) {
      final encoded = input[name];
      if (encoded is! String) throw StateError('Missing box');
      final bytes = base64Decode(encoded);
      // Memory backend: no source path, no lock, no recovery or compaction writes.
      final box = await hive.openBox<dynamic>(name, bytes: bytes, crashRecovery: false, compactionStrategy: (_, __) => false);
      result[name] = box.keys.map((key) => {'key': encodeValue(key), 'value': encodeValue(box.get(key))}).toList();
      await box.close();
    }
    stdout.write(jsonEncode({'formatVersion': 1, 'boxes': result}));
  } catch (_) {
    // Never echo Hive values or a stack trace containing user data.
    stderr.write('Codexter Hive 解码失败：数据损坏、版本不匹配或存在未识别类型。');
    exitCode = 1;
  } finally { await Hive.close(); }
}
