// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Cinnamon = imports.gi.Cinnamon;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Params = imports.misc.params;
const Search = imports.ui.search;
const Util = imports.misc.util;

const DEBUG = false;

/**
 * Represents a place object, which is most normally a bookmark entry,
 * a mount/volume, or a special place like the Home Folder, Computer, and Network.
 *
 * @name: String title
 * @iconFactory: A JavaScript callback which will create an icon texture given a size parameter
 * @launch: A JavaScript callback to launch the entry
 */
function PlaceInfo(id, name, iconFactory, launch) {
    this._init(id, name, iconFactory, launch);
}

PlaceInfo.prototype = {
    _init: function(id, name, iconFactory, launch) {
        this.id = id;
        this.idDecoded = decodeURIComponent(this.id);
        this.name = name;
        this._lowerName = name.toLowerCase();
        this.iconFactory = iconFactory;
        this.launch = launch;
    },

    matchTerms: function(terms) {
        let mtype = Search.MatchType.NONE;
        for (let i = 0; i < terms.length; i++) {
            let term = terms[i];
            let idx = this._lowerName.indexOf(term);
            if (idx == 0) {
                mtype = Search.MatchType.PREFIX;
            } else if (idx > 0) {
                if (mtype == Search.MatchType.NONE)
                    mtype = Search.MatchType.SUBSTRING;
            } else {
                return Search.MatchType.NONE;
            }
        }
        return mtype;
    },

    isRemovable: function() {
        return false;
    }
};

// Helper function to translate launch parameters into a GAppLaunchContext
function _makeLaunchContext(params)
{
    params = Params.parse(params, { workspace: -1,
                                    timestamp: 0 });

    let launchContext = global.create_app_launch_context();
    if (params.workspace != -1)
        launchContext.set_desktop(params.workspace);
    if (params.timestamp != 0)
        launchContext.set_timestamp(params.timestamp);

    return launchContext;
}

function PlaceDeviceInfo(mount) {
    this._init(mount);
}

PlaceDeviceInfo.prototype = {
    __proto__: PlaceInfo.prototype,

    _init: function(mount) {
        this._mount = mount;
        this.name = mount.get_name();
        this._lowerName = this.name.toLowerCase();
        this.id = 'mount:' + mount.get_root().get_uri();
        this.idDecoded = decodeURIComponent(this.id);

        this.busyWaitId = 0;
        this.destroySignalId = 0;
        this.busyNotification = null;
    },

    iconFactory: function(size) {
        let icon = this._mount.get_icon();
        return new St.Icon( { gicon: icon, icon_size: size });
    },

    launch: function(params) {
        Gio.app_info_launch_default_for_uri(this._mount.get_root().get_uri(),
                                            _makeLaunchContext(params));
    },

    isRemovable: function() {
        return this._mount.can_unmount();
    },

    remove: function() {
        if (this.busyWaitId > 0) {
            Mainloop.source_remove(this.busyWaitId);
            this.busyWaitId = 0;
        }

        if (this.busyNotification != null) {
            this.busyNotification.destroy();
        }

        this._tryRemove();
    },

    _tryRemove: function() {
        if (!this.isRemovable())
            return;

        let mountOp = new Gio.MountOperation(this._mount);
        let drive = this._mount.get_drive();
        let volume = this._mount.get_volume();

        if (drive &&
            drive.get_start_stop_type() == Gio.DriveStartStopType.SHUTDOWN &&
            drive.can_stop()) {
            drive.stop(0, mountOp, null, Lang.bind(this, this._stopFinish));
        } else {
            if (drive && drive.can_eject())
                drive.eject_with_operation(0, mountOp, null, Lang.bind(this, this._ejectFinish, true));
            else if (volume && volume.can_eject())
                volume.eject_with_operation(0, mountOp, null, Lang.bind(this, this._ejectFinish, false));
            else if (this._mount.can_eject())
                this._mount.eject_with_operation(0, mountOp, null, Lang.bind(this, this._ejectFinish, false));
            else if (this._mount.can_unmount())
                this._mount.unmount_with_operation(0, mountOp, null, Lang.bind(this, this._removeFinish));
        }

        this.busyWaitId = 0;
        return false;
    },

    _sendNotification: function(msg1, msg2 = null, withButton = false, persistent = false) {
        if (Main.messageTray) {
            if (persistent && this.busyNotification != null) {
                return;
            }

            if (!persistent && this.busyNotification) {
                this.busyNotification.destroy();
                this.busyNotification = null;
            }

            let source = new MessageTray.SystemNotificationSource();
            Main.messageTray.add(source);
            let notification = new MessageTray.Notification(source, msg1, msg2);
            notification.setTransient(true);
            notification.setUrgency(persistent ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.NORMAL);
            if (withButton) {
                notification.addButton('system-undo', _("Retry"));
                notification.connect('action-invoked', Lang.bind(this, this.remove));
            }
            source.notify(notification);
            if (persistent) {
                this.busyNotification = notification;
                this.destroySignalId = notification.connect("destroy", () => {
                    this.busyNotification.disconnect(this.destroySignalId);
                    this.busyNotification = null;
                    this.destroySignalId = 0;
                })
            }
        } else {
            if (msg2)
                global.log(msg1 + ': ' + msg2);
            else
                global.log(msg1);
        }
    },

    _stopFinish: function(drive, res) {
        if (DEBUG) global.log("PlacesManager: **_stopFinish**");
        let driveName = drive.get_name();  // Ex: USB Flash Drive
        let unixDevice = drive.get_identifier('unix-device'); // Ex: /dev/sdc
        let msg1 = _("%s (%s) has just been stopped.").format(driveName, this.name);
        let msg2 = _("Device %s can be turned off, if necessary.").format(unixDevice);
        let btn = false; // Show the 'Retry' button?
        try {
            drive.stop_finish(res);
        } catch(e) {
            if (e.code == Gio.IOErrorEnum.BUSY) {
                msg1 = _("Device %s is busy, please wait.".format(drive.get_name()));
                msg2 = _("Do not disconnect or data loss may occur.");

                this._sendNotification(msg1, msg2, false, true);
                this.busyWaitId = Mainloop.timeout_add_seconds(2, ()=>this._tryRemove());
                return;
            }
            btn = true;
            msg1 = _("Unable to stop the drive %s (%s)").format(drive.get_name(), this.name);
            msg2 = e.message;
        }
        if (DEBUG) global.log(msg1 + ": " + msg2);
        this._sendNotification(msg1, msg2, btn);
    },

    _ejectFinish: function(source, res, is_drive) {
        if (DEBUG) global.log("PlacesManager: **_ejectFinish**");
        let msg1;
        let msg2 = null;
        let btn = false;

        if (is_drive) {
            let driveName = source.get_name();  // Ex: USB Flash Drive
            let unixDevice = source.get_identifier('unix-device'); // Ex: /dev/sdc
            msg1 = _("%s (%s) can be safely unplugged.").format(driveName, this.name);
            msg2 = _("Device %s can be removed.").format(unixDevice);
        } else {
            msg1 = _("%s (%s) has just been ejected.").format(source.get_name(), this.name);
        }
        try {
            source.eject_with_operation_finish(res);
        } catch(e) {
            if (e.code == Gio.IOErrorEnum.BUSY) {
                msg1 = _("Device %s is busy, please wait.".format(source.get_name()));
                msg2 = _("Do not remove or data loss may occur.");

                this._sendNotification(msg1, msg2, false, true);
                this.busyWaitId = Mainloop.timeout_add_seconds(2, ()=>this._tryRemove());
                return;
            }
            btn = true;
            msg1 = _("Unable to eject the drive %s (%s)").format(source.get_name(), this.name);
            msg2 = e.message;
        }
        if (DEBUG) global.log(msg1 + ": " + msg2);
        this._sendNotification(msg1, msg2, btn);
    },

    _removeFinish: function(o, res, data) {
        if (DEBUG) global.log("PlacesManager: **_removeFinish**");
        let msg1 = _("Succesfully unmounted %s (%s)").format(o.get_name(), this.name);
        let msg2 = null;
        let btn = false;

        // 'this._mount.can_eject()' seems to be ever false. Thus, only the 'else' part will be used.
        // If no issues are reported, these 19 lines of code commented below can be deleted.
        //~ if (this._mount.can_eject()) {
            //~ msg1 = _("%s (%s) can be safely unplugged").format(o.get_name(), this.name);
            //~ msg2 = _("Device can be removed");
            //~ try {
                //~ this._mount.eject_with_operation_finish(res);
            //~ } catch(e) {
                //~ btn = true;
                //~ msg1 = _("Failed to eject %s (%s)").format(o.get_name(), this.name);
                //~ msg2 = e.message;
            //~ }
        //~ } else {
            //~ try {
                //~ this._mount.unmount_with_operation_finish(res);
            //~ } catch(e) {
                //~ btn = true;
                //~ msg1 = _("Failed to unmount %s (%s)").format(o.get_name(), this.name);
                //~ msg2 = e.message;
            //~ }
        //~ }
        // <--Beginning of the code replacing the 19 lines above:
        try {
            this._mount.unmount_with_operation_finish(res);
        } catch(e) {
            if (e.code == Gio.IOErrorEnum.BUSY) {
                msg1 = _("Device %s is busy, please wait.".format(o.get_name()));
                msg2 = _("Do not disconnect or data loss may occur.");

                this._sendNotification(msg1, msg2, false, true);
                this.busyWaitId = Mainloop.timeout_add_seconds(2, ()=>this._tryRemove());
                return;
            }
            btn = true;
            msg1 = _("Failed to unmount %s (%s)").format(o.get_name(), this.name);
            msg2 = e.message;
        }
        // End of this code.-->

        if (DEBUG) global.log(msg1 + ": " + msg2);
        this._sendNotification(msg1, msg2, btn);
    }
};

function PlacesManager() {
    this._init();
}

PlacesManager.prototype = {
    _init: function() {
        this._defaultPlaces = [];
        this._mounts = [];
        this._bookmarks = [];

        let homeFile = Gio.file_new_for_path (GLib.get_home_dir());
        let homeUri = homeFile.get_uri();
        let homeLabel = Cinnamon.util_get_label_for_uri (homeUri);
        let homeIcon = Cinnamon.util_get_icon_for_uri (homeUri);
        this._home = new PlaceInfo('special:home', homeLabel,
            function(size) {
                return new St.Icon({ gicon: homeIcon, icon_size: size });
            },
            function(params) {
                Gio.app_info_launch_default_for_uri(homeUri, _makeLaunchContext(params));
            });

        let desktopPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP);
        let desktopFile = Gio.file_new_for_path (desktopPath);
        let desktopUri = desktopFile.get_uri();
        let desktopLabel = Cinnamon.util_get_label_for_uri (desktopUri);
        let desktopIcon = Cinnamon.util_get_icon_for_uri (desktopUri);
        this._desktopMenu = new PlaceInfo('special:desktop', desktopLabel,
            function(size) {
                return new St.Icon({ gicon: desktopIcon, icon_size: size });
            },
            function(params) {
                Gio.app_info_launch_default_for_uri(desktopUri, _makeLaunchContext(params));
            });

        this._connect = new PlaceInfo('special:connect', _("Connect to..."),
            function (size) {
                return new St.Icon({ icon_name: 'applications-internet',
                                     icon_type: St.IconType.FULLCOLOR,
                                     icon_size: size });
            },
            function (params) {
                // BUG: nemo-connect-server doesn't have a desktop file, so we can't
                // launch it with the workspace from params. It's probably pretty rare
                // and odd to drag this place onto a workspace in any case

                Util.spawn(['nemo-connect-server']);
            });

        this._defaultPlaces.push(this._home);
        this._defaultPlaces.push(this._desktopMenu);
        this._defaultPlaces.push(this._connect);

        /*
        * Show devices, code more or less ported from nemo-places-sidebar.c
        */
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._volumeMonitor.connect('volume-added', Lang.bind(this, this._onVolumeAdded));
        this._volumeMonitor.connect('volume-removed',Lang.bind(this, this._onVolumeRemoved));
        this._volumeMonitor.connect('volume-changed', Lang.bind(this, this._onVolumeChanged));
        this._volumeMonitor.connect('mount-added', Lang.bind(this, this._onMountAdded));
        this._volumeMonitor.connect('mount-removed', Lang.bind(this, this._onMountRemoved));
        this._volumeMonitor.connect('mount-changed', Lang.bind(this, this._onMountChanged));
        this._volumeMonitor.connect('drive-connected', Lang.bind(this, this._onDriveConnected));
        this._volumeMonitor.connect('drive-disconnected', Lang.bind(this, this._onDriveDisconnected));
        this._volumeMonitor.connect('drive-changed', Lang.bind(this, this._onDriveChanged));

        this._deviceUpdateAwaiting = false;

        this._updateDevices();

        this._bookmarksFile = null;
        this._bookmarksPath = null;

        let bookmarksPath3 = GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-3.0', 'bookmarks']);
        let bookmarksFile3 = Gio.file_new_for_path(bookmarksPath3);

        if (!bookmarksFile3.query_exists(null)) {
            let bookmarksPath2 = GLib.build_filenamev([GLib.get_home_dir(), '.gtk-bookmarks']);
            let bookmarksFile2 = Gio.file_new_for_path(bookmarksPath2);

            if (bookmarksFile2.query_exists(null)) {
                this._bookmarksFile = bookmarksFile2;
                this._bookmarksPath = bookmarksPath2;
            }
        }

        if (this._bookmarksFile === null) {
            this._bookmarksPath = bookmarksPath3;
            this._bookmarksFile = bookmarksFile3;
        }

        this._bookmarkTimeoutId = 0;

        this.monitor = this._bookmarksFile.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this.monitor.connect('changed', () => {
            if (this._bookmarkTimeoutId > 0)
                return;
            /* Defensive event compression */
            this._bookmarkTimeoutId = Mainloop.timeout_add(100, () => {
                this._bookmarkTimeoutId = 0;
                this._reloadBookmarks();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._reloadBookmarks();
    },

    // Mounting a device triggers a lot of different events, wait 3 seconds and try to only call this._updateDevices() once
    _updateDevicesAsync: function() {
        if (this._deviceUpdateAwaiting == false) {
            this._deviceUpdateAwaiting = true;
            Mainloop.timeout_add(3000, Lang.bind(this, function () {
                this._updateDevices();
            }));
        }
    },

    _onVolumeAdded: function() {
        this._updateDevicesAsync();
    },

    _onVolumeRemoved: function() {
        this._updateDevicesAsync();
    },

    _onVolumeChanged: function() {
        this._updateDevicesAsync();
    },

    _onMountAdded: function() {
        this._updateDevicesAsync();
    },

    _onMountRemoved: function() {
        this._updateDevicesAsync();
    },

    _onMountChanged: function() {
        this._updateDevicesAsync();
    },

    _onDriveConnected: function() {
        Main.soundManager.play('plug');
        this._updateDevicesAsync();
    },

    _onDriveDisconnected: function() {
        Main.soundManager.play('unplug');
        this._updateDevicesAsync();
    },

    _onDriveChanged: function() {
        this._updateDevicesAsync();
    },

    _updateDevices: function() {
        this._deviceUpdateAwaiting = false;
        if (DEBUG) global.log("PlacesManager: Updating devices");
        this._mounts = [];

        /* first go through all connected drives */
        let drives = this._volumeMonitor.get_connected_drives();
        for (let i = 0; i < drives.length; i++) {
            let volumes = drives[i].get_volumes();
            for(let j = 0; j < volumes.length; j++) {
                let mount = volumes[j].get_mount();
                if(mount != null) {
                    this._addMount(mount);
                }
            }
        }

        /* add all volumes that is not associated with a drive */
        let volumes = this._volumeMonitor.get_volumes();
        for(let i = 0; i < volumes.length; i++) {
            if(volumes[i].get_drive() != null)
                continue;

            let mount = volumes[i].get_mount();
            if(mount != null) {
                this._addMount(mount);
            }
        }

        /* add mounts that have no volume (/etc/mtab mounts, ftp, sftp,...) */
        let mounts = this._volumeMonitor.get_mounts();
        for(let i = 0; i < mounts.length; i++) {
            if(mounts[i].is_shadowed())
                continue;

            if(mounts[i].get_volume())
                continue;

            this._addMount(mounts[i]);
        }

        /* We emit two signals, one for a generic 'all places' update
         * and the other for one specific to mounts. We do this because
         * clients like PlaceDisplay may only care about places in general
         * being updated while clients like DashPlaceDisplay care which
         * specific type of place got updated.
         */
        this.emit('mounts-updated');
        this.emit('places-updated');

    },

    _reloadBookmarks: function() {
        let had_bookmarks = this._bookmarks.length > 0;
        this._bookmarks = [];

        if (!this._bookmarksFile.query_exists(null)) {
            if (had_bookmarks) {
                this.emit('bookmarks-updated');
                this.emit('places-updated');
            }

            return;
        }

        let bookmarksContent = Cinnamon.get_file_contents_utf8_sync(this._bookmarksPath);

        let bookmarks = bookmarksContent.split('\n');

        let bookmarksToLabel = {};
        let bookmarksOrder = [];
        for (let i = 0; i < bookmarks.length; i++) {
            let bookmarkLine = bookmarks[i];
            let components = bookmarkLine.split(' ');
            let bookmark = components[0];
            if (bookmark in bookmarksToLabel)
                continue;
            let label = null;
            if (components.length > 1)
                label = components.slice(1).join(' ');
            bookmarksToLabel[bookmark] = label;
            bookmarksOrder.push(bookmark);
        }

        for (let i = 0; i < bookmarksOrder.length; i++) {
            let bookmark = bookmarksOrder[i];
            let label = bookmarksToLabel[bookmark];
            let file = Gio.file_new_for_uri(bookmark);
            if (label == null)
                label = Cinnamon.util_get_label_for_uri(bookmark);
            if (label == null)
                continue;

            let item;
            if (file.query_exists(null)) {
                let icon = Cinnamon.util_get_icon_for_uri(bookmark);
                item = new PlaceInfo('bookmark:' + bookmark, label,
                        function(size) {
                            return new St.Icon({ gicon: icon, icon_size: size });
                        },
                        function(params) {
                            Gio.app_info_launch_default_for_uri(bookmark, _makeLaunchContext(params));
                        });
            } else {
                // Assume the bookmark is an unmounted network location
                // try to mount and open by the default file manager
                let icon = Gio.ThemedIcon.new('network-workgroup');
                item = new PlaceInfo('bookmark:' + bookmark, label,
                        function(size) {
                            return new St.Icon({ gicon: icon, icon_size: size });
                        },
                        function(params) {
                            let fileapp = Gio.app_info_get_default_for_type('inode/directory', true);
                            if (fileapp) {
                                fileapp.launch_uris([bookmark], _makeLaunchContext(params));
                            }
                        });
            }
            this._bookmarks.push(item);
        }

        /* See comment in _updateDevices for explanation why there are two signals. */
        this.emit('bookmarks-updated');
        this.emit('places-updated');
    },

    _addMount: function(mount) {
        let devItem = new PlaceDeviceInfo(mount);
        this._mounts.push(devItem);
    },

    getAllPlaces: function () {
        return [...this.getDefaultPlaces(), ...this.getBookmarks(), ...this.getMounts()];
    },

    getDefaultPlaces: function () {
        return this._defaultPlaces;
    },

    getBookmarks: function () {
        return this._bookmarks;
    },

    getMounts: function () {
        return this._mounts;
    },

    _lookupIndexById: function(sourceArray, id) {
        for (let i = 0; i < sourceArray.length; i++) {
            let place = sourceArray[i];
            if (place.id == id)
                return i;
        }
        return -1;
    },

    lookupPlaceById: function(id) {
        let colonIdx = id.indexOf(':');
        let type = id.substring(0, colonIdx);
        let sourceArray = null;
        if (type == 'special')
            sourceArray = this._defaultPlaces;
        else if (type == 'mount')
            sourceArray = this._mounts;
        else if (type == 'bookmark')
            sourceArray = this._bookmarks;
        return sourceArray[this._lookupIndexById(sourceArray, id)];
    },

    _removeById: function(sourceArray, id) {
        sourceArray.splice(this._lookupIndexById(sourceArray, id), 1);
    }
};
Signals.addSignalMethods(PlacesManager.prototype);


function PlaceSearchProvider() {
    this._init();
}

PlaceSearchProvider.prototype = {
    __proto__: Search.SearchProvider.prototype,

    _init: function() {
        Search.SearchProvider.prototype._init.call(this, "PLACES & DEVICES");
    },

    getResultMeta: function(resultId) {
        let placeInfo = Main.placesManager.lookupPlaceById(resultId);
        if (!placeInfo)
            return null;
        return { 'id': resultId,
                 'name': placeInfo.name,
                 'createIcon': function(size) {
                                   return placeInfo.iconFactory(size);
                               }
               };
    },

    activateResult: function(id, params) {
        let placeInfo = Main.placesManager.lookupPlaceById(id);
        placeInfo.launch(params);
    },

    _compareResultMeta: function (idA, idB) {
        let infoA = Main.placesManager.lookupPlaceById(idA);
        let infoB = Main.placesManager.lookupPlaceById(idB);
        return infoA.name.localeCompare(infoB.name);
    },

    _searchPlaces: function(places, terms) {
        let multiplePrefixResults = [];
        let prefixResults = [];
        let multipleSubstringResults = [];
        let substringResults = [];

        terms = terms.map(String.toLowerCase);

        for (let i = 0; i < places.length; i++) {
            let place = places[i];
            let mtype = place.matchTerms(terms);
            if (mtype == Search.MatchType.MULTIPLE_PREFIX)
                multiplePrefixResults.push(place.id);
            else if (mtype == Search.MatchType.PREFIX)
                prefixResults.push(place.id);
            else if (mtype == Search.MatchType.MULTIPLE_SUBSTRING)
                multipleSubstringResults.push(place.id);
            else if (mtype == Search.MatchType.SUBSTRING)
                substringResults.push(place.id);
        }
        multiplePrefixResults.sort(this._compareResultMeta);
        prefixResults.sort(this._compareResultMeta);
        multipleSubstringResults.sort(this._compareResultMeta);
        substringResults.sort(this._compareResultMeta);
        return [...multiplePrefixResults, ...prefixResults, ...multipleSubstringResults, ...substringResults];
    },

    getInitialResultSet: function(terms) {
        let places = Main.placesManager.getAllPlaces();
        return this._searchPlaces(places, terms);
    },

    getSubsearchResultSet: function(previousResults, terms) {
        let places = previousResults.map(function (id) { return Main.placesManager.lookupPlaceById(id); });
        return this._searchPlaces(places, terms);
    }
};
