package io.github.oklev.riverguide;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Lets the web app use the phone's own camera app (with its panorama, zoom and
 * night modes) and then pick up the photos it saved to the camera roll.
 *
 *   openCamera()            open the camera app in still-photo mode
 *   requestAccess()         ask for photo (and photo-location) access
 *   listSince({since})      photos taken/added since an epoch-ms time
 *   copyToCache({id})       copy one photo, with its original EXIF/GPS, to the app cache
 */
@CapacitorPlugin(
    name = "CameraRoll",
    permissions = {
        @Permission(alias = "photos", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "photosLegacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "mediaLocation", strings = { Manifest.permission.ACCESS_MEDIA_LOCATION }),
    }
)
public class CameraRollPlugin extends Plugin {

    private String photosAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "photos" : "photosLegacy";
    }

    private boolean hasPhotos() {
        return getPermissionState(photosAlias()) == PermissionState.GRANTED;
    }

    private boolean hasMediaLocation() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || getPermissionState("mediaLocation") == PermissionState.GRANTED;
    }

    private JSObject accessResult() {
        JSObject r = new JSObject();
        r.put("photos", hasPhotos());
        r.put("location", hasMediaLocation());
        return r;
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (hasPhotos() && hasMediaLocation()) {
            call.resolve(accessResult());
            return;
        }
        String[] aliases = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? new String[] { photosAlias(), "mediaLocation" }
            : new String[] { photosAlias() };
        requestPermissionForAliases(aliases, call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        call.resolve(accessResult());
    }

    @PluginMethod
    public void openCamera(PluginCall call) {
        try {
            Intent intent = new Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No camera app found");
        }
    }

    @PluginMethod
    public void listSince(PluginCall call) {
        if (!hasPhotos()) {
            call.reject("Photo access not granted", "NO_ACCESS");
            return;
        }
        long since = call.getLong("since", 0L);
        String[] projection = {
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT,
            MediaStore.Images.Media.MIME_TYPE,
        };
        // DATE_TAKEN is in ms (may be missing); DATE_ADDED is in seconds.
        String selection = MediaStore.Images.Media.DATE_TAKEN + " >= ? OR " + MediaStore.Images.Media.DATE_ADDED + " >= ?";
        String[] args = { String.valueOf(since), String.valueOf(since / 1000) };
        JSArray out = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, selection, args,
            MediaStore.Images.Media.DATE_ADDED + " ASC")) {
            if (c != null) {
                while (c.moveToNext()) {
                    JSObject o = new JSObject();
                    long taken = c.isNull(2) ? c.getLong(3) * 1000 : c.getLong(2);
                    o.put("id", String.valueOf(c.getLong(0)));
                    o.put("name", c.getString(1));
                    o.put("takenAt", taken);
                    o.put("width", c.getInt(4));
                    o.put("height", c.getInt(5));
                    o.put("mime", c.getString(6));
                    out.put(o);
                }
            }
        } catch (Exception e) {
            call.reject("Couldn't read the camera roll: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("photos", out);
        call.resolve(r);
    }

    @PluginMethod
    public void copyToCache(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("Missing id");
            return;
        }
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, Long.parseLong(id));
        // Without this, Android strips GPS from the EXIF it hands to apps.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasMediaLocation()) {
            uri = MediaStore.setRequireOriginal(uri);
        }
        File dir = new File(getContext().getCacheDir(), "camera-roll");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File file = new File(dir, id + ".jpg");
        try (InputStream in = getContext().getContentResolver().openInputStream(uri);
             OutputStream os = new FileOutputStream(file)) {
            if (in == null) throw new Exception("empty stream");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        } catch (Exception e) {
            call.reject("Couldn't copy photo: " + e.getMessage());
            return;
        }
        JSObject r = new JSObject();
        r.put("path", file.getAbsolutePath());
        call.resolve(r);
    }

    @PluginMethod
    public void clearCache(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), "camera-roll");
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
        call.resolve();
    }
}
