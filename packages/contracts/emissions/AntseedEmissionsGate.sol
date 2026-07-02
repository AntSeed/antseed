// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IANTSToken } from "../interfaces/IANTSToken.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistryV2 } from "../interfaces/IAntseedRegistryV2.sol";

/**
 * @title AntseedEmissionsGate
 * @notice Canonical ANTS mint authority and immutable emission curve.
 *
 *         Each offchain minter id controls one emission plan. The id owns the
 *         epoch share and minted amount; the configured controller is only the
 *         address currently authorized to mint against that id.
 */
contract AntseedEmissionsGate is IAntseedEmissionsGate, Ownable2Step, ReentrancyGuard {
    struct ShareCheckpoint {
        uint256 startEpoch;
        uint32 shareBps;
    }

    address public constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 public constant GENESIS = 1_775_728_461;
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant HALVING_INTERVAL = 104;
    uint256 public constant INITIAL_EMISSION = 5_000_000e18;
    uint256 public constant SHARE_DENOMINATOR = 100_000;
    uint256 public constant BURN_CAP_BPS = 30_000;
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant LEGACY_EMISSIONS_MINTER_ID = keccak256("antseed.emissions.legacy.v1");
    bytes32 public constant TEAM_MINTER_ID = keccak256("antseed.emissions.team.v1");
    bytes32 public constant RESERVE_MINTER_ID = keccak256("antseed.emissions.reserve.v1");

    IANTSToken private immutable _antsToken;
    IAntseedRegistryV2 public immutable registry;

    uint256 public immutable effectiveEpoch;
    bool public legacyEpochMintsDisabled;
    mapping(uint256 epoch => uint256 amount) public epochMinted;
    mapping(uint256 epoch => uint256 amount) public epochBurnedAmount;

    uint32 public totalMinterShareBps;
    mapping(bytes32 minterId => Minter config) private _minters;
    mapping(address controller => bytes32 minterId) public controllerMinterIds;
    mapping(bytes32 minterId => ShareCheckpoint[] checkpoints) private _minterShareCheckpoints;
    mapping(bytes32 minterId => mapping(uint256 epoch => uint256 amount)) public minterEpochMinted;

    event LegacyEpochMintsDisabled();
    event EmissionClaimed(
        bytes32 indexed minterId, address indexed controller, address indexed recipient, uint256 epoch, uint256 amount
    );
    event EmissionRemainderClaimed(
        bytes32 indexed minterId,
        address indexed controller,
        uint256 indexed epoch,
        uint256 burnedAmount,
        uint256 reserveAmount
    );
    event MinterSet(bytes32 indexed minterId, address indexed controller, uint32 shareBps, bool editable);
    event MinterRemoved(bytes32 indexed minterId, address indexed controller);
    event LegacyEmissionMinted(address indexed recipient, uint256 amount);

    error InvalidAddress();
    error InvalidValue();
    error EpochNotFinalized();
    error NotEmissionMinter();
    error NotLegacyEmissionsMinter();
    error MinterNotEditable();
    error BucketBudgetExceeded();
    error EpochEmissionExceeded();
    error LegacyEpochMintingDisabled();
    error LegacyEpochMintsStillEnabled();
    error MintersNotSet();
    error DepositsNotConfigured();
    error InvalidMinterId();
    error InvalidLegacyEpoch();

    constructor(address registry_, uint32 teamShareBps, uint32 reserveShareBps) Ownable(msg.sender) {
        if (registry_ == address(0)) revert InvalidAddress();
        _antsToken = IANTSToken(ANTS_TOKEN);
        registry = IAntseedRegistryV2(registry_);
        uint256 epoch = block.timestamp <= GENESIS ? 0 : (block.timestamp - GENESIS) / EPOCH_DURATION;
        effectiveEpoch = epoch + 1;

        address legacyMinter = registry.emissions();
        address teamWallet = registry.teamWallet();
        address protocolReserve = registry.protocolReserve();
        if (legacyMinter == address(0) || teamWallet == address(0) || protocolReserve == address(0)) {
            revert InvalidAddress();
        }

        controllerMinterIds[legacyMinter] = LEGACY_EMISSIONS_MINTER_ID;
        _minters[LEGACY_EMISSIONS_MINTER_ID] =
            Minter({ controller: legacyMinter, shareBps: uint32(SHARE_DENOMINATOR), editable: false });
        _recordMinterShare(LEGACY_EMISSIONS_MINTER_ID, 0, uint32(SHARE_DENOMINATOR));
        _setMinter(TEAM_MINTER_ID, teamWallet, teamShareBps, false);
        _setMinter(RESERVE_MINTER_ID, _emissionsReserve(), reserveShareBps, false);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        TOKEN AUTH FACADE
    // ═══════════════════════════════════════════════════════════════════

    function emissions() external view returns (address) {
        return address(this);
    }

    function antsToken() external view returns (address) {
        return address(this);
    }

    function deposits() external view returns (address) {
        return registry.deposits();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        OWNER CONFIGURATION
    // ═══════════════════════════════════════════════════════════════════

    function setMinter(bytes32 id, address controller, uint32 shareBps, bool editable) external onlyOwner {
        _setMinter(id, controller, shareBps, editable);
    }

    function setMinterController(bytes32 id, address controller) external onlyOwner {
        _setMinterController(id, controller);
    }

    function removeMinter(bytes32 id) external onlyOwner {
        _removeMinter(id);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIMING
    // ═══════════════════════════════════════════════════════════════════

    function claim(uint256 epoch, address recipient, uint256 amount) external nonReentrant {
        bytes32 id = controllerMinterIds[msg.sender];
        if (id == LEGACY_EMISSIONS_MINTER_ID) revert NotEmissionMinter();
        _claimFromMinter(id, msg.sender, epoch, recipient, amount);
    }

    function claimRemainder(uint256 epoch, address reserveRecipient, uint256 amount)
        external
        nonReentrant
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        bytes32 id = controllerMinterIds[msg.sender];
        if (id == LEGACY_EMISSIONS_MINTER_ID) revert NotEmissionMinter();
        if (amount == 0) revert InvalidValue();

        address emissionsReserve = _emissionsReserve();
        if (emissionsReserve == address(0) || reserveRecipient != emissionsReserve) revert InvalidAddress();

        _chargeMinterBudget(id, msg.sender, epoch, amount);

        uint256 burnCap = _shareBudget(epoch, uint32(BURN_CAP_BPS));
        uint256 alreadyBurned = epochBurnedAmount[epoch];
        if (alreadyBurned < burnCap) {
            uint256 remainingBurn = burnCap - alreadyBurned;
            burnedAmount = amount < remainingBurn ? amount : remainingBurn;
            epochBurnedAmount[epoch] = alreadyBurned + burnedAmount;
        }
        reserveAmount = amount - burnedAmount;

        if (burnedAmount != 0) _antsToken.mint(DEAD_ADDRESS, burnedAmount);
        if (reserveAmount != 0) _antsToken.mint(reserveRecipient, reserveAmount);
        emit EmissionRemainderClaimed(id, msg.sender, epoch, burnedAmount, reserveAmount);
    }

    function mint(address recipient, uint256 amount) external nonReentrant {
        if (msg.sender != _minters[LEGACY_EMISSIONS_MINTER_ID].controller) revert NotLegacyEmissionsMinter();

        _claimFromMinter(LEGACY_EMISSIONS_MINTER_ID, msg.sender, effectiveEpoch - 1, recipient, amount);
        emit LegacyEmissionMinted(recipient, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function minters(bytes32 id) external view returns (address controller, uint32 shareBps, bool editable) {
        Minter memory minter = _minters[id];
        return (minter.controller, minter.shareBps, minter.editable);
    }

    function minterConfig(bytes32 id) external view returns (Minter memory) {
        return _minters[id];
    }

    function minterEpochBudget(bytes32 id, uint256 epoch) public view returns (uint256) {
        Minter memory minter = _minters[id];
        if (minter.controller == address(0)) return 0;
        return _shareBudget(epoch, _minterShareBpsAt(id, epoch));
    }

    function controllerEpochBudget(address controller, uint256 epoch) public view returns (uint256) {
        return minterEpochBudget(controllerMinterIds[controller], epoch);
    }

    function currentEpoch() public view returns (uint256) {
        if (block.timestamp <= GENESIS) return 0;
        return (block.timestamp - GENESIS) / EPOCH_DURATION;
    }

    function getEpochEmission(uint256 epoch) public pure returns (uint256) {
        return INITIAL_EMISSION >> (epoch / HALVING_INTERVAL);
    }

    function currentEmissionRate() external view returns (uint256) {
        return getEpochEmission(currentEpoch()) / EPOCH_DURATION;
    }

    function genesis() external pure returns (uint256) {
        return GENESIS;
    }

    function epochDuration() external pure returns (uint256) {
        return EPOCH_DURATION;
    }

    function halvingInterval() external pure returns (uint256) {
        return HALVING_INTERVAL;
    }

    function initialEmission() external pure returns (uint256) {
        return INITIAL_EMISSION;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ONE-TIME WIRING
    // ═══════════════════════════════════════════════════════════════════

    function disableLegacyEpochMints() external onlyOwner {
        if (legacyEpochMintsDisabled) revert LegacyEpochMintingDisabled();
        legacyEpochMintsDisabled = true;
        emit LegacyEpochMintsDisabled();
    }

    function renounceOwnership() public override onlyOwner {
        if (totalMinterShareBps != SHARE_DENOMINATOR) revert MintersNotSet();
        if (registry.deposits() == address(0)) revert DepositsNotConfigured();
        if (!legacyEpochMintsDisabled) revert LegacyEpochMintsStillEnabled();
        super.renounceOwnership();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _setMinter(bytes32 id, address controller, uint32 shareBps, bool editable) internal {
        if (id == bytes32(0)) revert InvalidMinterId();
        if (controller == address(0)) revert InvalidAddress();
        if (shareBps == 0) revert InvalidValue();

        Minter memory existing = _minters[id];
        if (existing.controller != address(0) && !existing.editable) revert MinterNotEditable();

        bytes32 assignedId = controllerMinterIds[controller];
        if (assignedId != bytes32(0) && assignedId != id) revert InvalidMinterId();

        uint32 previousShareBps = existing.controller == address(0) ? 0 : existing.shareBps;
        uint32 nextTotalMinterShareBps = totalMinterShareBps - previousShareBps + shareBps;
        if (nextTotalMinterShareBps > SHARE_DENOMINATOR) revert InvalidValue();

        if (existing.controller != address(0) && existing.controller != controller) {
            delete controllerMinterIds[existing.controller];
        }
        controllerMinterIds[controller] = id;

        totalMinterShareBps = nextTotalMinterShareBps;
        _minters[id] = Minter({ controller: controller, shareBps: shareBps, editable: editable });
        uint256 startEpoch = _minterShareCheckpoints[id].length == 0 ? 0 : currentEpoch() + 1;
        _recordMinterShare(id, startEpoch, shareBps);
        emit MinterSet(id, controller, shareBps, editable);
    }

    function _setMinterController(bytes32 id, address controller) internal {
        if (id == bytes32(0)) revert InvalidMinterId();
        if (controller == address(0)) revert InvalidAddress();

        Minter memory existing = _minters[id];
        if (existing.controller == address(0)) revert NotEmissionMinter();

        bytes32 assignedId = controllerMinterIds[controller];
        if (assignedId != bytes32(0) && assignedId != id) revert InvalidMinterId();

        if (existing.controller != controller) {
            delete controllerMinterIds[existing.controller];
            controllerMinterIds[controller] = id;
            _minters[id] = Minter({ controller: controller, shareBps: existing.shareBps, editable: existing.editable });
        }

        emit MinterSet(id, controller, existing.shareBps, existing.editable);
    }

    function _removeMinter(bytes32 id) internal {
        if (id == bytes32(0)) revert InvalidMinterId();
        Minter memory existing = _minters[id];
        if (existing.controller == address(0)) revert NotEmissionMinter();
        if (!existing.editable) revert MinterNotEditable();

        totalMinterShareBps -= existing.shareBps;
        _recordMinterShare(id, currentEpoch(), 0);
        delete controllerMinterIds[existing.controller];
        delete _minters[id];
        emit MinterRemoved(id, existing.controller);
    }

    function _claimFromMinter(bytes32 id, address controller, uint256 epoch, address recipient, uint256 amount)
        internal
    {
        if (recipient == address(0)) revert InvalidAddress();

        _chargeMinterBudget(id, controller, epoch, amount);

        _antsToken.mint(recipient, amount);
        emit EmissionClaimed(id, controller, recipient, epoch, amount);
    }

    function _chargeMinterBudget(bytes32 id, address controller, uint256 epoch, uint256 amount) internal {
        Minter memory minter = _minters[id];
        if (minter.controller == address(0) || minter.controller != controller) revert NotEmissionMinter();
        if (amount == 0) revert InvalidValue();
        if (id == LEGACY_EMISSIONS_MINTER_ID && epoch != effectiveEpoch - 1) revert InvalidLegacyEpoch();
        if (epoch >= currentEpoch()) revert EpochNotFinalized();
        if (epoch < effectiveEpoch && legacyEpochMintsDisabled) revert LegacyEpochMintingDisabled();

        uint256 newMinterMinted = minterEpochMinted[id][epoch] + amount;
        if (newMinterMinted > _shareBudget(epoch, _minterShareBpsAt(id, epoch))) revert BucketBudgetExceeded();
        minterEpochMinted[id][epoch] = newMinterMinted;

        uint256 minted = epochMinted[epoch] + amount;
        if (minted > getEpochEmission(epoch)) revert EpochEmissionExceeded();
        epochMinted[epoch] = minted;
    }

    function _shareBudget(uint256 epoch, uint32 shareBps) internal pure returns (uint256) {
        return (getEpochEmission(epoch) * shareBps) / SHARE_DENOMINATOR;
    }

    /// @dev ANTS reserve flows go to the registry's dedicated emissions
    ///      reserve; while the split is unset they fall back to the fee
    ///      reserve (`protocolReserve`).
    function _emissionsReserve() internal view returns (address reserve) {
        reserve = registry.emissionsReserve();
        if (reserve == address(0)) reserve = registry.protocolReserve();
    }

    function _recordMinterShare(bytes32 id, uint256 startEpoch, uint32 shareBps) internal {
        ShareCheckpoint[] storage checkpoints = _minterShareCheckpoints[id];
        uint256 length = checkpoints.length;

        if (length != 0 && checkpoints[length - 1].startEpoch == startEpoch) {
            checkpoints[length - 1].shareBps = shareBps;
            return;
        }

        checkpoints.push(ShareCheckpoint({ startEpoch: startEpoch, shareBps: shareBps }));
    }

    function _minterShareBpsAt(bytes32 id, uint256 epoch) internal view returns (uint32) {
        ShareCheckpoint[] storage checkpoints = _minterShareCheckpoints[id];
        uint256 length = checkpoints.length;
        if (length == 0 || epoch < checkpoints[0].startEpoch) return 0;

        uint256 low;
        uint256 high = length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (checkpoints[mid].startEpoch <= epoch) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        return checkpoints[low - 1].shareBps;
    }
}
