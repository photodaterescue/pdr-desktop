import os
import json
import shutil
import tempfile
import zipfile
import re
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file
from werkzeug.utils import secure_filename
import piexif
from PIL import Image
import hashlib  # NEW: for duplicate detection

app = Flask(__name__, static_folder='static', template_folder='templates')
# 200MB max request size for free web version
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024
app.config['SECRET_KEY'] = os.environ.get('SESSION_SECRET', 'dev-secret-key')

UPLOAD_FOLDER = tempfile.gettempdir()
ALLOWED_EXTENSIONS = {'zip'}

# WhatsApp filename pattern: IMG/VID-YYYYMMDD-WAxxxx
WA_PATTERN = re.compile(r'(?:IMG|VID)[-_](\d{4})(\d{2})(\d{2})[-_]WA\d+', re.IGNORECASE)


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def safe_extract_zip(zip_file, extract_path):
    abs_extract_path = os.path.abspath(extract_path)

    for member in zip_file.namelist():
        if os.path.isabs(member):
            raise ValueError(f"ZIP contains absolute path: {member}")

        member_path = os.path.abspath(os.path.join(extract_path, member))

        try:
            common = os.path.commonpath([abs_extract_path, member_path])
            if common != abs_extract_path:
                raise ValueError(f"ZIP contains path traversal: {member}")
        except ValueError:
            raise ValueError(f"ZIP contains unsafe path: {member}")

    zip_file.extractall(extract_path)


def cleanup_temp_dirs(temp_dirs):
    for temp_dir in temp_dirs:
        try:
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)
        except Exception as e:
            print(f"Error cleaning up {temp_dir}: {e}")


def extract_xmp_metadata(image_path):
    try:
        with open(image_path, 'rb') as f:
            content = f.read()

        xmp_start = content.find(b'<x:xmpmeta')
        xmp_end = content.find(b'</x:xmpmeta>')

        if xmp_start != -1 and xmp_end != -1:
            xmp_data = content[xmp_start:xmp_end + 12]

            try:
                xmp_str = xmp_data.decode('utf-8', errors='ignore')

                date_patterns = [
                    r'xmp:CreateDate[=>"\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})',
                    r'exif:DateTimeOriginal[=>"\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})',
                    r'photoshop:DateCreated[=>"\s]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})',
                ]

                for pattern in date_patterns:
                    match = re.search(pattern, xmp_str)
                    if match:
                        date_str = match.group(1)
                        dt = datetime.strptime(date_str[:19], '%Y-%m-%dT%H:%M:%S')
                        return {'timestamp': int(dt.timestamp()), 'orientation': None}

                orientation_pattern = r'tiff:Orientation[=>"\s]+(\d+)'
                orient_match = re.search(orientation_pattern, xmp_str)
                orientation = int(orient_match.group(1)) if orient_match else None

                return {'timestamp': None, 'orientation': orientation}
            except:
                pass

        return None
    except Exception as e:
        print(f"Error extracting XMP from {image_path}: {e}")
        return None


def parse_filename_for_date(filename):
    """
    Generic filename-based timestamp (non-WhatsApp).
    Returns a POSIX timestamp or None.
    """
    patterns = [
        r'(\d{4})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})[-_]?(\d{2})',
        r'(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})',
        r'IMG[-_](\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})',
        r'VID[-_](\d{4})(\d{2})(\d{2})[-_](\d{2})(\d{2})(\d{2})',
        # WhatsApp-specific pattern handled separately
        r'IMG[-_](\d{4})(\d{2})(\d{2})[-_]\d+',
        r'(\d{4})[-_](\d{2})[-_](\d{2})',
        r'(\d{4})(\d{2})(\d{2})',
    ]

    for pattern in patterns:
        match = re.search(pattern, filename)
        if match:
            groups = match.groups()
            try:
                if len(groups) >= 6:
                    year, month, day, hour, minute, second = map(int, groups[:6])
                    dt = datetime(year, month, day, hour, minute, second)
                elif len(groups) >= 3:
                    year, month, day = map(int, groups[:3])
                    dt = datetime(year, month, day, 12, 0, 0)
                else:
                    continue

                if 1970 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31:
                    return int(dt.timestamp())
            except ValueError:
                continue

    return None


def get_timestamp_from_filename(filename):
    """
    Wrapper that:
    - detects WhatsApp IMG/VID-YYYYMMDD-WA#### → returns 12:00:00 + is_wa=True
    - otherwise falls back to parse_filename_for_date → is_wa=False
    """
    m = WA_PATTERN.search(filename)
    if m:
        year, month, day = map(int, m.groups())
        dt = datetime(year, month, day, 12, 0, 0)
        return int(dt.timestamp()), True

    ts = parse_filename_for_date(filename)
    return ts, False


def parse_google_takeout_json(json_path):
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        timestamp = None
        if 'photoTakenTime' in data:
            timestamp_data = data['photoTakenTime']
            if 'timestamp' in timestamp_data:
                timestamp = int(timestamp_data['timestamp'])
        elif 'creationTime' in data:
            timestamp_data = data['creationTime']
            if 'timestamp' in timestamp_data:
                timestamp = int(timestamp_data['timestamp'])

        return timestamp
    except Exception as e:
        print(f"Error parsing JSON {json_path}: {e}")
        return None


def get_apple_photos_metadata(image_path):
    try:
        img = Image.open(image_path)
        try:
            exif_dict = piexif.load(img.info.get('exif', b''))
            if piexif.ExifIFD.DateTimeOriginal in exif_dict.get('Exif', {}):
                date_str = exif_dict['Exif'][piexif.ExifIFD.DateTimeOriginal].decode('utf-8')
                dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                return int(dt.timestamp())
        except:
            pass

        file_mtime = os.path.getmtime(image_path)
        return int(file_mtime)
    except Exception as e:
        print(f"Error getting Apple metadata for {image_path}: {e}")
        return None


def set_exif_datetime(image_path, timestamp):
    """
    Force-write EXIF timestamps even for images that have NO EXIF block
    (e.g., WhatsApp, Messenger, screenshots, edited images).
    """
    dt = datetime.fromtimestamp(timestamp)
    dt_str = dt.strftime('%Y:%m:%d %H:%M:%S')

    try:
        img = Image.open(image_path)
        
        # Only process actual JPEG images
        if img.format not in ('JPEG', 'MPO'):
            img.close()
            # Just update filesystem timestamps for non-JPEG
            os.utime(image_path, (timestamp, timestamp))
            return True

        # Try loading existing EXIF; if missing, create a new structure
        try:
            exif_dict = piexif.load(img.info.get("exif", b""))
        except:
            exif_dict = {
                "0th": {},
                "Exif": {},
                "GPS": {},
                "1st": {},
                "thumbnail": None
            }

        # Preserve orientation if it exists
        orientation = None
        if "0th" in exif_dict and piexif.ImageIFD.Orientation in exif_dict["0th"]:
            orientation = exif_dict["0th"][piexif.ImageIFD.Orientation]

        # Create a clean EXIF structure with only essential tags
        # This avoids issues with malformed tags from various sources
        clean_exif = {
            "0th": {},
            "Exif": {},
            "GPS": {},
            "1st": {},
            "thumbnail": None
        }

        # Write timestamps
        clean_exif["Exif"][piexif.ExifIFD.DateTimeOriginal] = dt_str.encode("utf-8")
        clean_exif["Exif"][piexif.ExifIFD.DateTimeDigitized] = dt_str.encode("utf-8")
        clean_exif["0th"][piexif.ImageIFD.DateTime] = dt_str.encode("utf-8")

        # Restore orientation if it existed
        if orientation is not None:
            clean_exif["0th"][piexif.ImageIFD.Orientation] = orientation

        exif_bytes = piexif.dump(clean_exif)

        # Save JPEG with EXIF block inserted
        img.save(image_path, "jpeg", exif=exif_bytes, quality=95)
        img.close()

        # Also update filesystem timestamps
        os.utime(image_path, (timestamp, timestamp))

        return True

    except Exception as e:
        print(f"Error injecting EXIF into {image_path}: {e}")
        # Still try to update filesystem timestamps as fallback
        try:
            os.utime(image_path, (timestamp, timestamp))
        except:
            pass
        return False


def detect_export_type(extract_path):
    has_json_files = False
    has_photos = False

    for root, dirs, files in os.walk(extract_path):
        for file in files:
            if file.lower().endswith('.json'):
                has_json_files = True
            if file.lower().endswith(('.jpg', '.jpeg', '.png', '.heic', '.heif')):
                has_photos = True

        if has_json_files and has_photos:
            return 'google_takeout'

    if has_photos:
        return 'apple_photos'

    return 'unknown'


def process_google_takeout(extract_path, output_path,
                           use_mtime_fallback=False,
                           skip_no_metadata=False,
                           remove_duplicates=False):
    stats = {
        'total_files': 0,
        'fixed': 0,
        'restored_from_filename': 0,
        'renamed_only': 0,
        'skipped': 0,
        'duplicates_removed': 0
    }

    photo_extensions = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp'}
    seen_hashes = {}       # key: (size, sha1) -> kept filename
    duplicate_log = []     # for report file

    for root, dirs, files in os.walk(extract_path):
        for file in files:
            file_lower = file.lower()
            file_ext = Path(file_lower).suffix

            if file_ext in photo_extensions:
                stats['total_files'] += 1
                image_path = os.path.join(root, file)

                # ---- Duplicate detection (exact) ----
                file_size = os.path.getsize(image_path)
                sha1 = hashlib.sha1()
                with open(image_path, 'rb') as f:
                    for chunk in iter(lambda: f.read(8192), b''):
                        sha1.update(chunk)
                file_hash = sha1.hexdigest()
                dup_key = (file_size, file_hash)

                if remove_duplicates and dup_key in seen_hashes:
                    stats['duplicates_removed'] += 1
                    duplicate_log.append(f"{file} -> duplicate of {seen_hashes[dup_key]}")
                    continue
                else:
                    seen_hashes[dup_key] = file

                timestamp = None
                classification = None
                is_wa = False

                json_path = image_path + '.json'
                if not os.path.exists(json_path):
                    json_path = os.path.join(root, Path(file).stem + '.json')

                if os.path.exists(json_path):
                    timestamp = parse_google_takeout_json(json_path)
                    if timestamp:
                        classification = 'fixed'

                if timestamp is None:
                    try:
                        img = Image.open(image_path)
                        exif_dict = piexif.load(img.info.get('exif', b''))
                        if piexif.ExifIFD.DateTimeOriginal in exif_dict.get('Exif', {}):
                            date_str = exif_dict['Exif'][piexif.ExifIFD.DateTimeOriginal].decode('utf-8')
                            dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                            timestamp = int(dt.timestamp())
                            classification = 'fixed'
                    except:
                        pass

                if timestamp is None:
                    xmp_data = extract_xmp_metadata(image_path)
                    if xmp_data and xmp_data['timestamp']:
                        timestamp = xmp_data['timestamp']
                        classification = 'fixed'

                if timestamp is None:
                    timestamp, is_wa = get_timestamp_from_filename(file)
                    if timestamp:
                        classification = 'restored_from_filename'

                if timestamp is None and use_mtime_fallback:
                    try:
                        mtime = os.path.getmtime(image_path)
                        timestamp = int(mtime)
                        classification = 'fixed'
                    except:
                        pass

                if timestamp is None:
                    if skip_no_metadata:
                        stats['skipped'] += 1
                        continue
                    else:
                        classification = 'renamed_only'
                        needs_review_folder = os.path.join(output_path, 'Needs_Review')
                        os.makedirs(needs_review_folder, exist_ok=True)
                        new_path = os.path.join(needs_review_folder, file)
                        shutil.copy2(image_path, new_path)
                        stats['renamed_only'] += 1
                        continue

                dt = datetime.fromtimestamp(timestamp)
                year_folder = os.path.join(output_path, str(dt.year))
                os.makedirs(year_folder, exist_ok=True)

                # New naming:
                #   YYYY-MM-DD_HH-MM-SS.ext              → normal
                #   YYYY-MM-DD_HH-MM-SS_WA.ext          → WhatsApp
                #   YYYY-MM-DD_HH-MM-SS_FN.ext          → date from filename (no EXIF)
                #   YYYY-MM-DD_HH-MM-SS_WA_FN.ext       → WA + from filename
                base_name = dt.strftime('%Y-%m-%d_%H-%M-%S')

                # Flags
                from_filename = (classification == 'restored_from_filename')

                if is_wa:
                    base_name += '_WA'
                if from_filename:
                    base_name += '_FN'

                new_filename = f"{base_name}{file_ext}"
                new_path = os.path.join(year_folder, new_filename)

                # Collision handling: _001, _002, ... (for same timestamp)
                counter = 1
                while os.path.exists(new_path):
                    new_filename = f"{base_name}_{counter:03d}{file_ext}"
                    new_path = os.path.join(year_folder, new_filename)
                    counter += 1

                shutil.copy2(image_path, new_path)

                if file_ext in {'.jpg', '.jpeg'}:
                    set_exif_datetime(new_path, timestamp)
                else:
                    os.utime(new_path, (timestamp, timestamp))

                if classification:
                    stats[classification] += 1

    # Write duplicate report (if any)
    if remove_duplicates and stats['duplicates_removed'] > 0:
        report_path = os.path.join(output_path, 'duplicates_report.txt')
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(f"Duplicates removed: {stats['duplicates_removed']}\n\n")
            for line in duplicate_log:
                f.write(line + "\n")

    return stats


def process_apple_photos(extract_path, output_path,
                         use_mtime_fallback=False,
                         skip_no_metadata=False,
                         remove_duplicates=False):
    stats = {
        'total_files': 0,
        'fixed': 0,
        'restored_from_filename': 0,
        'renamed_only': 0,
        'skipped': 0,
        'duplicates_removed': 0
    }

    photo_extensions = {'.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.bmp', '.webp'}
    seen_hashes = {}
    duplicate_log = []

    for root, dirs, files in os.walk(extract_path):
        for file in files:
            file_lower = file.lower()
            file_ext = Path(file_lower).suffix

            if file_ext in photo_extensions:
                stats['total_files'] += 1
                image_path = os.path.join(root, file)

                # ---- Duplicate detection (exact) ----
                file_size = os.path.getsize(image_path)
                sha1 = hashlib.sha1()
                with open(image_path, 'rb') as f:
                    for chunk in iter(lambda: f.read(8192), b''):
                        sha1.update(chunk)
                file_hash = sha1.hexdigest()
                dup_key = (file_size, file_hash)

                if remove_duplicates and dup_key in seen_hashes:
                    stats['duplicates_removed'] += 1
                    duplicate_log.append(f"{file} -> duplicate of {seen_hashes[dup_key]}")
                    continue
                else:
                    seen_hashes[dup_key] = file

                timestamp = None
                classification = None
                is_wa = False

                try:
                    img = Image.open(image_path)
                    exif_dict = piexif.load(img.info.get('exif', b''))
                    if piexif.ExifIFD.DateTimeOriginal in exif_dict.get('Exif', {}):
                        date_str = exif_dict['Exif'][piexif.ExifIFD.DateTimeOriginal].decode('utf-8')
                        dt = datetime.strptime(date_str, '%Y:%m:%d %H:%M:%S')
                        timestamp = int(dt.timestamp())
                        classification = 'fixed'
                except:
                    pass

                if timestamp is None:
                    xmp_data = extract_xmp_metadata(image_path)
                    if xmp_data and xmp_data['timestamp']:
                        timestamp = xmp_data['timestamp']
                        classification = 'fixed'

                if timestamp is None:
                    timestamp, is_wa = get_timestamp_from_filename(file)
                    if timestamp:
                        classification = 'restored_from_filename'

                if timestamp is None and use_mtime_fallback:
                    try:
                        mtime = os.path.getmtime(image_path)
                        timestamp = int(mtime)
                        classification = 'fixed'
                    except:
                        pass

                if timestamp is None:
                    if skip_no_metadata:
                        stats['skipped'] += 1
                        continue
                    else:
                        classification = 'renamed_only'
                        needs_review_folder = os.path.join(output_path, 'Needs_Review')
                        os.makedirs(needs_review_folder, exist_ok=True)
                        new_path = os.path.join(needs_review_folder, file)
                        shutil.copy2(image_path, new_path)
                        stats['renamed_only'] += 1
                        continue

                dt = datetime.fromtimestamp(timestamp)
                year_folder = os.path.join(output_path, str(dt.year))
                os.makedirs(year_folder, exist_ok=True)

                # New naming:
                #   YYYY-MM-DD_HH-MM-SS.ext              → normal
                #   YYYY-MM-DD_HH-MM-SS_WA.ext          → WhatsApp
                #   YYYY-MM-DD_HH-MM-SS_FN.ext          → date from filename (no EXIF)
                #   YYYY-MM-DD_HH-MM-SS_WA_FN.ext       → WA + from filename
                base_name = dt.strftime('%Y-%m-%d_%H-%M-%S')

                from_filename = (classification == 'restored_from_filename')

                if is_wa:
                    base_name += '_WA'
                if from_filename:
                    base_name += '_FN'

                new_filename = f"{base_name}{file_ext}"
                new_path = os.path.join(year_folder, new_filename)

                # Collision handling: _001, _002, ...
                counter = 1
                while os.path.exists(new_path):
                    new_filename = f"{base_name}_{counter:03d}{file_ext}"
                    new_path = os.path.join(year_folder, new_filename)
                    counter += 1

                shutil.copy2(image_path, new_path)

                if file_ext in {'.jpg', '.jpeg'}:
                    set_exif_datetime(new_path, timestamp)
                else:
                    os.utime(new_path, (timestamp, timestamp))

                if classification:
                    stats[classification] += 1

    if remove_duplicates and stats['duplicates_removed'] > 0:
        report_path = os.path.join(output_path, 'duplicates_report.txt')
        with open(report_path, 'w', encoding='utf-8') as f:
            f.write(f"Duplicates removed: {stats['duplicates_removed']}\n\n")
            for line in duplicate_log:
                f.write(line + "\n")

    return stats


@app.route('/health')
def health():
    return 'OK', 200


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/upload', methods=['POST'])
def upload_file():
    temp_dirs = []

    try:
        if 'file' not in request.files:
            return jsonify({'error': 'No file uploaded'}), 400

        file = request.files['file']

        if file.filename == '':
            return jsonify({'error': 'No file selected'}), 400

        if not allowed_file(file.filename):
            return jsonify({'error': 'Only ZIP files are allowed'}), 400

        # Enforce 200MB limit for free web version
        MAX_WEB_SIZE = 200 * 1024 * 1024  # 200MB

        file.seek(0, os.SEEK_END)
        size = file.tell()
        file.seek(0)

        if size > MAX_WEB_SIZE:
            cleanup_temp_dirs(temp_dirs)
            return jsonify({'error': 'This free web version supports ZIP files up to 200MB.'}), 400

        upload_dir = tempfile.mkdtemp(prefix='upload_')
        temp_dirs.append(upload_dir)
        extract_dir = tempfile.mkdtemp(prefix='extract_')
        temp_dirs.append(extract_dir)
        output_dir = tempfile.mkdtemp(prefix='output_')
        temp_dirs.append(output_dir)

        filename = secure_filename(file.filename or 'upload.zip')
        zip_path = os.path.join(upload_dir, filename)
        file.save(zip_path)

        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            safe_extract_zip(zip_ref, extract_dir)

        export_type = detect_export_type(extract_dir)

        use_mtime_fallback = request.form.get('use_mtime_fallback', 'false') == 'true'
        skip_no_metadata = request.form.get('skip_no_metadata', 'false') == 'true'
        remove_duplicates = request.form.get('remove_duplicates', 'false') == 'true'

        if export_type == 'unknown':
            cleanup_temp_dirs(temp_dirs)
            return jsonify({'error': 'Could not detect export type. Please upload a valid Google Takeout or Apple Photos export.'}), 400

        if export_type == 'google_takeout':
            stats = process_google_takeout(
                extract_dir,
                output_dir,
                use_mtime_fallback,
                skip_no_metadata,
                remove_duplicates
            )
        else:
            stats = process_apple_photos(
                extract_dir,
                output_dir,
                use_mtime_fallback,
                skip_no_metadata,
                remove_duplicates
            )

        output_zip_path = os.path.join(upload_dir, 'fixed_photos.zip')
        with zipfile.ZipFile(output_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(output_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, output_dir)
                    zipf.write(file_path, arcname)

        response = send_file(
            output_zip_path,
            as_attachment=True,
            download_name='fixed_photos.zip',
            mimetype='application/zip'
        )

        @response.call_on_close
        def cleanup():
            cleanup_temp_dirs(temp_dirs)

        response.headers['X-Export-Type'] = export_type
        response.headers['X-Total-Files'] = str(stats['total_files'])
        response.headers['X-Fixed-Files'] = str(stats['fixed'])
        response.headers['X-Restored-Files'] = str(stats['restored_from_filename'])
        response.headers['X-Renamed-Files'] = str(stats['renamed_only'])
        response.headers['X-Skipped-Files'] = str(stats['skipped'])
        response.headers['X-Duplicates-Removed'] = str(stats.get('duplicates_removed', 0))

        return response

    except zipfile.BadZipFile:
        cleanup_temp_dirs(temp_dirs)
        return jsonify({'error': 'Invalid ZIP file'}), 400
    except ValueError as e:
        cleanup_temp_dirs(temp_dirs)
        return jsonify({'error': f'Security error: {str(e)}'}), 400
    except Exception as e:
        cleanup_temp_dirs(temp_dirs)
        return jsonify({'error': f'Processing error: {str(e)}'}), 500


if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
