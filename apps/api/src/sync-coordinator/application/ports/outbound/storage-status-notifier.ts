export interface StorageStatusNotifier {
	notifyStorageStatusChanged(): void;
	dispose(): void;
}
