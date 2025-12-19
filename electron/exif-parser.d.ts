declare module 'exif-parser' {
  interface ExifResult {
    tags: {
      DateTimeOriginal?: number;
      CreateDate?: number;
      ModifyDate?: number;
      Make?: string;
      Model?: string;
      Orientation?: number;
      GPSLatitude?: number;
      GPSLongitude?: number;
      ImageWidth?: number;
      ImageHeight?: number;
      [key: string]: unknown;
    };
    imageSize?: {
      width: number;
      height: number;
    };
    thumbnailOffset?: number;
    thumbnailLength?: number;
    thumbnailType?: number;
    app1Offset?: number;
    hasThumbnail(mime: string): boolean;
    getThumbnailBuffer(): Buffer;
  }

  interface ExifParser {
    parse(): ExifResult;
  }

  function create(buffer: Buffer): ExifParser;
  
  export { create, ExifParser, ExifResult };
}
